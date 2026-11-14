#!/usr/bin/env node
/**
 * @file scripts/test-in-lxd.js
 * @description
 * Backs `npm run test:system`: the end-to-end test of
 * x1-validator-private-rpc on a real Ubuntu 24.04 system with systemd, in
 * a throwaway LXD container on the development machine; never on a
 * validator. Its first phase, the nginx upgrade check, is described
 * here; its second, apply and the commands after it, in
 * scripts/_lxd-apply-phase.js. It launches the container, copies in
 * the feature and Node.js 20.0.0 (the validator's version), installs the
 * runtime dependencies, and runs the check as the container's ordinary
 * user, who has sudo, as a validator's account does. Then it confirms
 * the container is as clean as before and deletes it. What counts as
 * clean comes from the app: the paths in the settings the check loads in
 * the container, nginx.org's repository files, and the folders above
 * them, so this test keeps no copy of a default.
 *
 * It needs LXD, and network access from the container to Ubuntu's
 * archive, nginx.org, npm's registry and GitHub, for Pebble. It isn't
 * part of `npm run check`. Run it with `--help` for its usage and exit
 * codes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideFilePath } from "../x1-validator-private-rpc/src/lib/settings.js";
import {
  asRoot,
  asUser,
  asUserArgs,
  GUEST_PROJECT,
  leftovers,
  mustPass,
  pathsTheToolMightCreate,
  existingPaths,
} from "./_lxd.js";
import { runApplyPhase } from "./_lxd-apply-phase.js";
import {
  projectRoot,
  runCaptured,
  runInherited,
  scriptProgram,
} from "./_tools.js";

const IMAGE = "ubuntu:24.04";
const NODE_TARBALL = "node-v20.0.0-linux-x64.tar.xz";

/** Prints, as json, the settings the check loads, using the app's code. */
const PRINT_SETTINGS =
  'import { loadSettings } from "./x1-validator-private-rpc/src/lib/settings.js";' +
  "process.stdout.write(JSON.stringify(loadSettings()));";

/**
 * Copies Node.js 20.0.0 into the container: nvm's downloaded copy when
 * there is one, otherwise a fresh download inside the container.
 * @param {string} name  The container.
 */
function installNode(name) {
  const home = os.homedir();
  const cached = path.join(
    home,
    ".nvm",
    ".cache",
    "bin",
    "node-v20.0.0-linux-x64",
    NODE_TARBALL,
  );
  if (fs.existsSync(cached)) {
    const copied = runInherited("lxc", [
      "file",
      "push",
      cached,
      `${name}/tmp/${NODE_TARBALL}`,
    ]);
    mustPass(copied, "Copying Node.js into the container");
  } else {
    const downloaded = asRoot(name, [
      "curl",
      "-fsSL",
      "-o",
      `/tmp/${NODE_TARBALL}`,
      `https://nodejs.org/dist/v20.0.0/${NODE_TARBALL}`,
    ]);
    mustPass(downloaded, "Downloading Node.js in the container");
  }
  const made = asRoot(name, ["mkdir", "-p", "/opt/node"]);
  mustPass(made, "Making /opt/node");
  const unpacked = asRoot(name, [
    "tar",
    "-xJf",
    `/tmp/${NODE_TARBALL}`,
    "-C",
    "/opt/node",
    "--strip-components=1",
  ]);
  mustPass(unpacked, "Unpacking Node.js");
}

/**
 * Copies the feature and the package files into the container, as the
 * container's ordinary user, leaving out every file in the operator's
 * settings folder, so the check runs on the shipped settings.
 * @param {string} name  The container.
 * @param {string} workFolder  A local temporary folder.
 */
function copyProject(name, workFolder) {
  const archive = path.join(workFolder, "project.tar.gz");
  const operatorFolder = path.relative(
    projectRoot(),
    path.dirname(overrideFilePath()),
  );
  const packed = runInherited("tar", [
    "-czf",
    archive,
    "-C",
    projectRoot(),
    `--exclude=${operatorFolder}/*`,
    "package.json",
    "package-lock.json",
    "x1-validator-private-rpc",
  ]);
  mustPass(packed, "Packing the project");
  const copied = runInherited("lxc", [
    "file",
    "push",
    archive,
    `${name}/tmp/project.tar.gz`,
  ]);
  mustPass(copied, "Copying the project into the container");
  const made = asRoot(name, [
    "install",
    "-d",
    "-o",
    "ubuntu",
    "-g",
    "ubuntu",
    GUEST_PROJECT,
  ]);
  mustPass(made, "Making the project's folder");
  const unpacked = asUser(name, ["tar", "-xzf", "/tmp/project.tar.gz"]);
  mustPass(unpacked, "Unpacking the project");
}

/**
 * Reads the settings the check loads in the container, from the app.
 * @param {string} name  The container.
 * @returns {object}
 */
function guestSettings(name) {
  const result = runCaptured(
    "lxc",
    asUserArgs(name, ["node", "--input-type=module", "--eval", PRINT_SETTINGS]),
  );
  mustPass(result.status, "Reading the check's settings in the container");
  return JSON.parse(result.stdout);
}

/**
 * Sets up the container, runs the check and inspects the container,
 * then runs the apply phase there.
 * @param {string} name  The container.
 * @param {string} workFolder  A local temporary folder.
 * @returns {Promise<boolean>} Whether both phases passed.
 */
async function runTest(name, workFolder) {
  const launched = runInherited("lxc", ["launch", IMAGE, name]);
  mustPass(launched, "Launching");
  const booted = asRoot(name, ["cloud-init", "status", "--wait"]);
  mustPass(booted, "Waiting for the container to finish booting");
  installNode(name);
  copyProject(name, workFolder);
  const installed = asUser(name, [
    "npm",
    "ci",
    "--omit=dev",
    "--ignore-scripts",
  ]);
  mustPass(installed, "Installing the runtime dependencies");
  const settings = guestSettings(name);
  const paths = pathsTheToolMightCreate(settings);
  const before = existingPaths(name, paths);
  console.log("\n── The nginx upgrade check ──");
  const checkStatus = asUser(name, [
    "node",
    "x1-validator-private-rpc/util/validate-nginx-upgrade/index.js",
  ]);
  const left = leftovers(name, paths, before);
  for (const item of left) {
    console.error(`Left behind: ${item}`);
  }
  if (checkStatus !== 0 || left.length > 0) {
    return false;
  }
  console.log("\n── apply and the commands after it ──");
  return runApplyPhase(name, () => guestSettings(name));
}

/**
 * Runs the test in a new container, and deletes the container after,
 * unless asked to keep it.
 */
async function main() {
  const program = scriptProgram(
    "scripts/test-in-lxd.js",
    "Runs x1-validator-private-rpc end to end in a throwaway Ubuntu 24.04 " +
      "LXD container: first the nginx upgrade check, which must leave the " +
      "container clean; then apply, ensure, turn-off-private-rpc, " +
      "turn-on-private-rpc, unlock, url and undo-apply, with Pebble in place " +
      "of Let's Encrypt, ending with a container as apply found it. Then it " +
      "deletes the container.",
    [
      "0  both phases passed",
      "1  a phase failed, or the container couldn't be set up",
    ],
  ).option("--keep", "keep the container for a look inside");
  program.parse();
  const { keep } = program.opts();
  const name = `x1vs-system-test-${process.pid}`;
  const tempRoot = os.tmpdir();
  const workFolder = fs.mkdtempSync(path.join(tempRoot, "x1vs-lxd-"));
  let passed = false;
  try {
    passed = await runTest(name, workFolder);
  } catch (error) {
    console.error(error.message);
  } finally {
    fs.rmSync(workFolder, { recursive: true, force: true });
    if (keep === true) {
      console.log(`Kept the container ${name}.`);
    } else {
      runInherited("lxc", ["delete", "--force", name]);
    }
  }
  console.log(passed ? "\nSystem test passed." : "\nSystem test failed.");
  process.exit(passed ? 0 : 1);
}

await main();
