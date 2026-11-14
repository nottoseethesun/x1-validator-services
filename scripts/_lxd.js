/**
 * @file scripts/_lxd.js
 * @description
 * Shared helpers for the LXD system test, scripts/test-in-lxd.js, and
 * its phases:
 *
 * - running a command in the test's container as root, or as the
 *   container's ordinary user from the project's folder with Node.js
 *   20.0.0 first on the PATH, as a validator's account runs the tool
 * - reading the start script and ufw's rules there
 * - stopping the test when a set-up step fails
 * - finding what a run of the tool left behind
 *
 * What counts as left behind comes from the app: the paths in the
 * settings the tool loads in the container, nginx.org's repository
 * files, the folders above them, the nginx package and its account.
 */

import path from "node:path";
import { startScriptPathOf } from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
} from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { runCaptured, runInherited } from "./_tools.js";

/** Where the project sits in the container. */
export const GUEST_PROJECT = "/home/ubuntu/x1-validator-services";

/** The container's ordinary user's home. */
export const GUEST_HOME = "/home/ubuntu";

const GUEST_PATH = "/opt/node/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * Runs a command in the container as its user, capturing its output.
 * @param {string} name  The container.
 * @param {string[]} command  The command.
 * @returns {{status: number, stdout: string}}
 */
export function asUserCaptured(name, command) {
  return asRootCaptured(name, ["runuser", "-u", "ubuntu", "--", ...command]);
}

/**
 * Reads the start script in the container.
 * @param {string} name  The container.
 * @param {object} settings  The settings the tool loads there.
 * @returns {string}
 */
export function readScript(name, settings) {
  const scriptPath = startScriptPathOf(settings, GUEST_HOME);
  return asUserCaptured(name, ["cat", scriptPath]).stdout;
}

/**
 * Reads whether ufw holds a rule, from the rules the ufw command added.
 * That list holds them even while ufw is off, as it is in a fresh
 * container, whose `ufw status` lists none.
 * @param {string} name  The container.
 * @param {string} line  The rule as ufw lists it, such as
 *   `ufw allow 443/tcp`.
 * @returns {boolean}
 */
export function ufwHolds(name, line) {
  const added = asRootCaptured(name, ["ufw", "show", "added"]).stdout;
  return added.split("\n").includes(line);
}

/**
 * Reads whether ufw holds a rule that allows a port.
 * @param {string} name  The container.
 * @param {string} rule  The rule, such as `443/tcp`.
 * @returns {boolean}
 */
export function firewallAllows(name, rule) {
  return ufwHolds(name, `ufw allow ${rule}`);
}

/**
 * Runs a command in the container as root, streaming its output.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @returns {number} Its exit code.
 */
export function asRoot(name, command) {
  return runInherited("lxc", ["exec", name, "--", ...command]);
}

/**
 * Runs a command in the container as root, capturing its output.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function asRootCaptured(name, command) {
  return runCaptured("lxc", ["exec", name, "--", ...command]);
}

/**
 * Builds the arguments of `lxc` that run a command in the container as
 * its ordinary user, from the project's folder, with Node.js 20.0.0
 * first on the PATH.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @param {Object<string, string>} [env]  More environment variables.
 * @returns {string[]}
 */
export function asUserArgs(name, command, env = {}) {
  const variables = { HOME: GUEST_HOME, PATH: GUEST_PATH, ...env };
  return [
    "exec",
    name,
    "--user",
    "1000",
    "--group",
    "1000",
    "--cwd",
    GUEST_PROJECT,
    ...Object.entries(variables).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    "--",
    ...command,
  ];
}

/**
 * Runs a command in the container as its ordinary user, streaming its
 * output.
 * @param {string} name  The container.
 * @param {string[]} command  The command and its arguments.
 * @param {Object<string, string>} [env]  More environment variables.
 * @returns {number} Its exit code.
 */
export function asUser(name, command, env = {}) {
  return runInherited("lxc", asUserArgs(name, command, env));
}

/**
 * Stops the test with a message when a set-up step fails.
 * @param {number} status  The step's exit code.
 * @param {string} what  The step, in words.
 */
export function mustPass(status, what) {
  if (status !== 0) {
    throw new Error(`${what} failed with exit code ${status}.`);
  }
}

/**
 * Lists every path a run of the tool might create: each absolute path in
 * its settings, nginx.org's repository files, the paths given, and every
 * folder above them.
 * @param {object} settings  The settings the tool loads in the container.
 * @param {string[]} [more]  More paths, such as ones in the user's home.
 * @returns {string[]}
 */
export function pathsTheToolMightCreate(settings, more = []) {
  const files = [
    ...Object.values(settings).filter(
      (value) => typeof value === "string" && value.startsWith("/"),
    ),
    NGINX_KEYRING_PATH,
    NGINX_APT_SOURCE_PATH,
    NGINX_APT_PIN_PATH,
    ...more,
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
export function existingPaths(name, paths) {
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
 * Lists what a run of the tool left behind in the container.
 * @param {string} name  The container.
 * @param {string[]} paths  The paths the run might create.
 * @param {string[]} before  Those that existed before the run.
 * @returns {string[]} One line per leftover; none when it's clean.
 */
export function leftovers(name, paths, before) {
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
