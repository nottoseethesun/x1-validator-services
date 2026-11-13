/**
 * @file scripts/_tools.js
 * @description
 * Shared helpers for the scripts that run the project's tools. They find
 * the project's root from this file's own location, so the working
 * directory never redirects a run. They find each tool's command in
 * `node_modules/.bin`, never through npx. They run a command either with
 * the terminal attached, so its output streams as it comes, or with its
 * output captured for a report. And they give every script the same
 * handling of `--help` and of arguments it doesn't take.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Handles a script's arguments before it does any work. Asked for help
 * with `--help` or `-h`, it prints the script's usage to stdout and exits
 * 0. Given an argument the script doesn't take, it prints the argument
 * and the usage to stderr and exits 1.
 * @param {string[]} args  The script's arguments, without node and the
 *   script's path.
 * @param {string[]} accepted  The arguments the script takes.
 * @param {string} usage  The script's usage text.
 */
export function checkScriptArgs(args, accepted, usage) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = args.filter((arg) => !accepted.includes(arg));
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(" ")}\n\n${usage}`);
    process.exit(1);
  }
}

/**
 * Lists the files under a folder, at any depth. It walks by hand because
 * Node.js 20.0.0, the oldest version the gate runs on, has neither
 * `fs.globSync` nor a recursive `fs.readdirSync`. A folder that doesn't
 * exist holds no files.
 * @param {string} root  The project's root.
 * @param {string} folder  The folder, relative to the root.
 * @returns {string[]} The files' paths, relative to the root.
 */
export function listFilesUnder(root, folder) {
  const absolute = path.join(root, folder);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(folder, entry.name);
    return entry.isDirectory() ? listFilesUnder(root, relative) : [relative];
  });
}

/**
 * Finds the project's root folder, one level above this file.
 * @returns {string} The absolute path of the project's root.
 */
export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Finds the command an npm package installs for a tool.
 * @param {string} name  The tool's command name, such as "eslint".
 * @returns {string} The command's absolute path in node_modules/.bin.
 */
export function toolPath(name) {
  return path.join(projectRoot(), "node_modules", ".bin", name);
}

/**
 * Runs a command in the project's root with the terminal attached, and
 * waits for it. A command killed by a signal has no exit code, and
 * counts as failed.
 * @param {string} command  The program to run.
 * @param {string[]} args  Its arguments, passed without a shell.
 * @returns {number} The command's exit code, or 1 when it has none.
 */
export function runInherited(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot(),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

/**
 * Runs a command in the project's root with its output captured, and
 * waits for it.
 * @param {string} command  The program to run.
 * @param {string[]} args  Its arguments, passed without a shell.
 * @returns {{status: number, stdout: string, stderr: string}} The exit
 *   code, 1 when the command has none, and everything it printed.
 */
export function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
