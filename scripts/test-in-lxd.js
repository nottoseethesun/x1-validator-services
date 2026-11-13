#!/usr/bin/env node
/**
 * @file scripts/test-in-lxd.js
 * @description
 * Backs `npm run test:system`: the end-to-end test of
 * x1-validator-private-rpc's nginx upgrade check, on a real Ubuntu 24.04
 * system with systemd, in a throwaway LXD container on the development
 * machine; never on a validator. It launches the container, copies in
 * the feature and Node.js 20.0.0 (the validator's version), installs the
 * runtime dependencies, and runs the check as the container's ordinary
 * user, who has sudo, as a validator's account does. Then it confirms
 * the container is as clean as before and deletes it. What counts as
 * clean comes from the app: the paths in the settings the check loads in
 * the container, nginx.org's repository files, and the folders above
 * them, so this test keeps no copy of a default.
 *
 * It needs LXD, and network access from the container to Ubuntu's
 * archive, nginx.org and npm's registry. It isn't part of `npm run
 * check`. Run it with `--help` for its usage and exit codes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
} from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { overrideFilePath } from "../x1-validator-private-rpc/src/lib/settings.js";
import {
  checkScriptArgs,
  projectRoot,
  runCaptured,
  runInherited,
} from "./_tools.js";

const USAGE = `Usage: node scripts/test-in-lxd.js [--keep]

Runs x1-validator-private-rpc's nginx upgrade check end to end in a
throwaway Ubuntu 24.04 LXD container, checks that it left the container
clean, and deletes the container. With --keep, the container stays for
a look inside.

Exit codes:
  0  the check passed and left the container clean
  1  it didn't, or the container couldn't be set up`;

const IMAGE = "ubuntu:24.04";
const NODE_TARBALL = "node-v20.0.0-linux-x64.tar.xz";
const GUEST_PROJECT = "/home/ubuntu/x1-validator-services";
const GUEST_PATH = "/opt/node/bin:/usr/local/bin:/usr/bin:/bin";

/** Prints, as json, the settings the check loads, using the app's code. */
const PRINT_SETTINGS =
  'import { loadSettings } from "./x1-validator-private-rpc/src/lib/settings.js";' +
  "process.stdout.write(JSON.stringify(loadSettings()));";

/**
 * Runs a command in the container as root, streaming its output.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @returns {number} Its exit code.
 */
function asRoot(name, command) {
  return runInherited("lxc", ["exec", name, "--", ...command]);
}

/**
 * Builds the arguments of `lxc` that run a command in the container as
 * its ordinary user, from the project's folder, with Node.js 20.0.0
 * first on the PATH.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @returns {string[]}
 */
function asUserArgs(name, command) {
  return [
    "exec",
    name,
    "--user",
    "1000",
    "--group",
    "1000",
    "--cwd",
    GUEST_PROJECT,
    "--env",
    "HOME=/home/ubuntu",
    "--env",
    `PATH=${GUEST_PATH}`,
    "--",
    ...command,
  ];
}

/**
 * Runs a command in the container as its ordinary user, streaming its
 * output.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @returns {number} Its exit code.
 */
function asUser(name, command) {
  return runInherited("lxc", asUserArgs(name, command));
}

/**
 * Stops the test with a message when a set-up step fails.
 * @param {number} status  The step's exit code.
 * @param {string} what  The step, in words.
 */
function mustPass(status, what) {
  if (status !== 0) {
    throw new Error(`${what} failed with exit code ${status}.`);
  }
}

/**
 * Copies Node.js 20.0.0 into the container: nvm's downloaded copy when
 * there is one, otherwise a fresh download inside the container.
 * @param {string} name  The container.
 */
function installNode(name) {
  const cached = path.join(
    os.homedir(),
    ".nvm",
    ".cache",
    "bin",
    "node-v20.0.0-linux-x64",
    NODE_TARBALL,
  );
  if (fs.existsSync(cached)) {
    mustPass(
      runInherited("lxc", [
        "file",
        "push",
        cached,
        `${name}/tmp/${NODE_TARBALL}`,
      ]),
      "Copying Node.js into the container",
    );
  } else {
    mustPass(
      asRoot(name, [
        "curl",
        "-fsSL",
        "-o",
        `/tmp/${NODE_TARBALL}`,
        `https://nodejs.org/dist/v20.0.0/${NODE_TARBALL}`,
      ]),
      "Downloading Node.js in the container",
    );
  }
  mustPass(asRoot(name, ["mkdir", "-p", "/opt/node"]), "Making /opt/node");
  mustPass(
    asRoot(name, [
      "tar",
      "-xJf",
      `/tmp/${NODE_TARBALL}`,
      "-C",
      "/opt/node",
      "--strip-components=1",
    ]),
    "Unpacking Node.js",
  );
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
  mustPass(
    runInherited("tar", [
      "-czf",
      archive,
      "-C",
      projectRoot(),
      `--exclude=${operatorFolder}/*`,
      "package.json",
      "package-lock.json",
      "x1-validator-private-rpc",
    ]),
    "Packing the project",
  );
  mustPass(
    runInherited("lxc", [
      "file",
      "push",
      archive,
      `${name}/tmp/project.tar.gz`,
    ]),
    "Copying the project into the container",
  );
  mustPass(
    asRoot(name, [
      "install",
      "-d",
      "-o",
      "ubuntu",
      "-g",
      "ubuntu",
      GUEST_PROJECT,
    ]),
    "Making the project's folder",
  );
  mustPass(
    asUser(name, ["tar", "-xzf", "/tmp/project.tar.gz"]),
    "Unpacking the project",
  );
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
 * Lists every path the check might create: each absolute path in its
 * settings, nginx.org's repository files, and every folder above them.
 * @param {object} settings  The settings the check loads.
 * @returns {string[]}
 */
function pathsTheCheckMightCreate(settings) {
  const files = [
    ...Object.values(settings).filter(
      (value) => typeof value === "string" && value.startsWith("/"),
    ),
    NGINX_KEYRING_PATH,
    NGINX_APT_SOURCE_PATH,
    NGINX_APT_PIN_PATH,
  ];
  const paths = new Set();
  for (const file of files) {
    for (let p = file; p !== path.posix.dirname(p); p = path.posix.dirname(p)) {
      paths.add(p);
    }
  }
  return [...paths].sort();
}

/**
 * Lists which of the given paths exist in the container.
 * @param {string} name  The container.
 * @param {string[]} paths  The paths.
 * @returns {string[]}
 */
function existingPaths(name, paths) {
  const result = runCaptured("lxc", [
    "exec",
    name,
    "--",
    "sh",
    "-c",
    'for p; do if [ -e "$p" ]; then echo "$p"; fi; done',
    "sh",
    ...paths,
  ]);
  mustPass(result.status, "Listing paths in the container");
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * Lists what the check left behind in the container.
 * @param {string} name  The container.
 * @param {string[]} paths  The paths the check might create.
 * @param {string[]} before  Those that existed before the check ran.
 * @returns {string[]} One line per leftover; none when it's clean.
 */
function leftovers(name, paths, before) {
  const found = existingPaths(name, paths).filter(
    (target) => !before.includes(target),
  );
  const nginx = runCaptured("lxc", [
    "exec",
    name,
    "--",
    "dpkg-query",
    "--show",
    "--showformat=${Status}",
    "nginx",
  ]);
  if (nginx.stdout.includes("ok installed")) {
    found.push("the nginx package");
  }
  if (asRoot(name, ["getent", "passwd", "nginx"]) === 0) {
    found.push("the nginx user");
  }
  return found;
}

/**
 * Sets up the container, runs the check and inspects the container.
 * @param {string} name  The container.
 * @param {string} workFolder  A local temporary folder.
 * @returns {boolean} Whether the check passed and left it clean.
 */
function runTest(name, workFolder) {
  mustPass(runInherited("lxc", ["launch", IMAGE, name]), "Launching");
  mustPass(
    asRoot(name, ["cloud-init", "status", "--wait"]),
    "Waiting for the container to finish booting",
  );
  installNode(name);
  copyProject(name, workFolder);
  mustPass(
    asUser(name, ["npm", "ci", "--omit=dev", "--ignore-scripts"]),
    "Installing the runtime dependencies",
  );
  const paths = pathsTheCheckMightCreate(guestSettings(name));
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
  return checkStatus === 0 && left.length === 0;
}

/**
 * Runs the test in a new container, and deletes the container after,
 * unless asked to keep it.
 */
function main() {
  const args = process.argv.slice(2);
  checkScriptArgs(args, ["--keep"], USAGE);
  const name = `x1vs-system-test-${process.pid}`;
  const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), "x1vs-lxd-"));
  let passed = false;
  try {
    passed = runTest(name, workFolder);
  } catch (error) {
    console.error(error.message);
  } finally {
    fs.rmSync(workFolder, { recursive: true, force: true });
    if (args.includes("--keep")) {
      console.log(`Kept the container ${name}.`);
    } else {
      runInherited("lxc", ["delete", "--force", name]);
    }
  }
  console.log(passed ? "\nSystem test passed." : "\nSystem test failed.");
  process.exit(passed ? 0 : 1);
}

main();
