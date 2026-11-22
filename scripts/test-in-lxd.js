#!/usr/bin/env node
/**
 * @file scripts/test-in-lxd.js
 * @description
 * Backs `npm run test:system`: the end-to-end test of
 * x1-validator-private-rpc on a real Ubuntu 24.04 system with systemd, in
 * a throwaway LXD container on the development machine, or on GitHub's
 * runner through .github/workflows/system-test.yml. It never runs on a
 * validator. Its first phase, the nginx upgrade check, is described
 * here. Its second, apply and the commands after it, is described in
 * scripts/_lxd-apply-phase.js. It launches the container, copies in
 * the feature and the newest release of the Node.js major that `engines`
 * in package.json names, the one validators run the tool on, and
 * installs the runtime dependencies. It runs the check as the container's
 * ordinary user, who has sudo, as a validator's account does, in a real
 * terminal, where it affirms the disclaimer's dialog. Then it
 * confirms the container is as clean as before and deletes it. What
 * counts as clean comes from the app: the paths in the settings the
 * check loads in the container, nginx.org's repository files, and the
 * folders above them, so this test keeps no copy of a default.
 *
 * It needs LXD, and network access to nodejs.org, and from the container
 * to Ubuntu's archive, nginx.org, npm's registry and GitHub, for Pebble.
 * It isn't
 * part of `npm run check`. Run it with `--help` for its usage, examples
 * and exit codes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { oldestNode } from "../x1-validator-private-rpc/src/lib/node-version.js";
import { overrideFilePath } from "../x1-validator-private-rpc/src/lib/settings.js";
import {
  AFFIRM_DISCLAIMER,
  answerInTerminal,
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
  requireMinNode,
  runCaptured,
  runInherited,
  scriptProgram,
} from "./_tools.js";

const IMAGE = "ubuntu:24.04";

/** nodejs.org's list of every Node.js release, the newest first. */
const NODE_RELEASES = "https://nodejs.org/dist/index.json";

/** Prints, as json, the settings the check loads, using the app's code. */
const PRINT_SETTINGS =
  'import { loadSettings } from "./x1-validator-private-rpc/src/lib/settings.js";' +
  "process.stdout.write(JSON.stringify(loadSettings()));";

/**
 * Finds the newest release of the Node.js major that `engines` in
 * package.json names, the one validators run the tool on.
 * @returns {Promise<string>} The version, such as "v24.22.3".
 */
async function newestNodeRelease() {
  const { major } = oldestNode();
  const response = await fetch(NODE_RELEASES);
  if (response.ok === false) {
    throw new Error(`${NODE_RELEASES} answered ${response.status}.`);
  }
  const releases = await response.json();
  return releases.find((release) => release.version.startsWith(`v${major}.`))
    .version;
}

/**
 * Copies a Node.js release into the container: nvm's downloaded copy
 * when there is one, otherwise a fresh download inside the container.
 * @param {string} name  The container.
 * @param {string} version  The release, such as "v24.22.3".
 */
function installNode(name, version) {
  const tarball = `node-${version}-linux-x64.tar.xz`;
  const cached = path.join(
    os.homedir(),
    ".nvm",
    ".cache",
    "bin",
    `node-${version}-linux-x64`,
    tarball,
  );
  if (fs.existsSync(cached)) {
    const copied = runInherited("lxc", [
      "file",
      "push",
      cached,
      `${name}/tmp/${tarball}`,
    ]);
    mustPass(copied, "Copying Node.js into the container");
  } else {
    const downloaded = asRoot(name, [
      "curl",
      "-fsSL",
      "-o",
      `/tmp/${tarball}`,
      `https://nodejs.org/dist/${version}/${tarball}`,
    ]);
    mustPass(downloaded, "Downloading Node.js in the container");
  }
  const made = asRoot(name, ["mkdir", "-p", "/opt/node"]);
  mustPass(made, "Making /opt/node");
  const unpacked = asRoot(name, [
    "tar",
    "-xJf",
    `/tmp/${tarball}`,
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
  installNode(name, await newestNodeRelease());
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
  const check = await answerInTerminal(
    name,
    "node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js",
    [AFFIRM_DISCLAIMER],
  );
  const left = leftovers(name, paths, before);
  for (const item of left) {
    console.error(`Left behind: ${item}`);
  }
  if (check.code !== 0 || left.length > 0) {
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
      "LXD container. First comes the nginx upgrade check, the feature's " +
      "first install step, which proves an apt upgrade of nginx keeps the " +
      "keyed url working. It must leave the container as it found it. " +
      "Then comes every command of the " +
      "tool, from apply, which sets it up, to undo-apply, which takes it " +
      "back, with Pebble, Let's Encrypt's test server, in place of Let's " +
      "Encrypt. undo-apply leaves nginx installed, so the test purges it " +
      "and runs undo-apply again, which must leave the container as apply " +
      "found it. Then it deletes the container.",
    {
      examples: [
        "npm run test:system",
        "    Before a merge, after a change to the tool's code or messages.",
        "    A changed message can break the test. It answers apply's stage",
        '    questions by their opening words, such as "Stage 2 of 8". It',
        "    answers other prompts by their whole text, which it takes from",
        "    the tool's code. And it checks what some commands print, such as",
        '    "holds 1 api key." from url, the command that prints the keyed',
        "    url. Needs LXD.",
        "npm run test:system -- --keep",
        "    The same, but keeps the container, which it names at the end,",
        "    to look inside with lxc exec <name> -- bash. Delete it after",
        "    with lxc delete --force <name>.",
      ],
      exitCodes: [
        "0  both phases passed",
        "1  a phase failed, or the container couldn't be set up",
      ],
    },
  ).option("--keep", "keep the container for a look inside", false);
  program.parse();
  requireMinNode("scripts/test-in-lxd.js");
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
  console.log(
    passed === true ? "\nSystem test passed." : "\nSystem test failed.",
  );
  process.exit(passed === true ? 0 : 1);
}

await main();
