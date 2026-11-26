/**
 * @file scripts/_lxd.js
 * @description
 * Shared helpers for the LXD system test, scripts/test-in-lxd.js, and
 * its phases:
 *
 * - running a command in the test's container as root, or as the
 *   container's ordinary user from the project's folder, with the
 *   Node.js the test copied in, the one validators run the tool on,
 *   first on the PATH
 * - running a command there in a real terminal, and answering its
 *   prompts as they appear, the disclaimer's dialog among them
 * - reading the start script and ufw's rules there
 * - stopping the test when a set-up step fails
 * - finding what a run of the tool left behind
 *
 * What counts as left behind comes from the app: the paths in the
 * settings the tool loads in the container, nginx.org's repository
 * files, nginx's log folder, the folders above them, the nginx package
 * and its account.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { startScriptPathOf } from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import { DECLINE_BUTTON } from "../x1-validator-private-rpc/src/lib/disclaimer.js";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  NGINX_LOG_DIR,
} from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { runCaptured, runInherited } from "./_tools.js";

/** Where the project sits in the container. */
export const GUEST_PROJECT = "/home/ubuntu/x1-validator-services";

/** The container's ordinary user's home. */
export const GUEST_HOME = "/home/ubuntu";

const GUEST_PATH = "/opt/node/bin:/usr/local/bin:/usr/bin:/bin";

/** How long a command run in a real terminal may take. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The answer to the disclaimer's dialog, which each run that can change
 * the system shows first, but for a run of ensure: once the dialog's
 * Decline button shows, the left arrow moves to Affirm, and Enter
 * chooses it.
 */
export const AFFIRM_DISCLAIMER = [DECLINE_BUTTON, "\x1b[D\r"];

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
 * its ordinary user, from the project's folder, with the Node.js the
 * test copied in first on the PATH.
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
 * Runs a command in the container as its user, in a real terminal of 80
 * by 24 that `script` makes, and answers its prompts as each one appears.
 * TERM is set, so whiptail knows the arrow keys.
 * @param {string} name  The container.
 * @param {string} command  The command, as the shell reads it.
 * @param {[string, string][]} answers  Each prompt's text, and its
 *   answer, in the order the command shows them. Each prompt is looked
 *   for only once the one before it is answered, so a prompt listed out
 *   of order goes unanswered, and a command waiting for it holds the test
 *   until the 10-minute limit.
 * @param {Object<string, string>} [env]  More environment variables.
 * @returns {Promise<{code: number, output: string}>}
 */
export function answerInTerminal(name, command, answers, env = {}) {
  return new Promise((resolve) => {
    const sized = `stty rows 24 cols 80; ${command}`;
    const child = spawn(
      "lxc",
      asUserArgs(name, ["script", "-qfec", sized, "/dev/null"], {
        TERM: "xterm",
        ...env,
      }),
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    let unread = "";
    let next = 0;
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      unread += chunk;
      let [prompt, reply] = answers.at(next) ?? [];
      while (
        prompt !== undefined &&
        prompt !== null &&
        unread.includes(prompt)
      ) {
        unread = unread.slice(unread.indexOf(prompt) + prompt.length);
        child.stdin.write(reply);
        next += 1;
        [prompt, reply] = answers.at(next) ?? [];
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
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
 * its settings, nginx.org's repository files, nginx's log folder, the
 * paths given, and every folder above them.
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
    NGINX_LOG_DIR,
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
 * @returns {string[]} One line per leftover, or none when it's clean.
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
