/**
 * @file x1-validator-private-rpc/src/lib/host.js
 * @description
 * The real host. Every effect the tool has outside its own process goes
 * through these functions: running commands, with or without sudo;
 * writing and removing files root owns; reading files; http and https
 * requests; picking a free port; pausing. Tests pass a stand-in with the
 * same functions instead, so no test touches the machine.
 *
 * The tool runs as the validator's user and never as root. Steps that
 * need root run as child processes through sudo. sudo asks for the
 * password on the terminal itself, not through the command's input or
 * output, so a command's output can be captured while the prompt still
 * reaches the person at the keyboard.
 *
 * Most commands run to the end before anything else happens. Long ones,
 * such as apt's, can run without blocking instead, so the terminal's
 * spinner keeps moving and a Ctrl-C is noticed while they work.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mustSucceed } from "./command-result.js";

/**
 * Runs a command and waits for it, capturing what it prints. A command
 * that can't start at all, such as one that isn't installed, gets exit
 * code 127, as a shell would give it.
 * @param {string} command  The program.
 * @param {string[]} args  Its arguments, passed without a shell.
 * @param {{input?: string|Buffer, binary?: boolean}} options  Text for
 *   its standard input, if any; and whether its stdout is binary data.
 * @returns {import("./command-result.js").CommandResult} With stdout as
 *   a Buffer when `binary` is set.
 */
function runCommand(command, args, { input, binary = false }) {
  const result = spawnSync(command, args, {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return {
      status: 127,
      stdout: binary ? Buffer.alloc(0) : "",
      stderr: result.error.message,
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: binary ? result.stderr.toString("utf8") : result.stderr,
  };
}

/**
 * Runs a command without blocking, capturing what it prints. As with
 * runCommand, a command that can't start gets exit code 127.
 * @param {string} command  The program.
 * @param {string[]} args  Its arguments, passed without a shell.
 * @returns {Promise<import("./command-result.js").CommandResult>}
 */
function runCommandAsync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({ status: 127, stdout: "", stderr: error.message }),
    );
    child.on("close", (code) =>
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

/**
 * Writes a file root owns, so that no reader ever sees it half written:
 * the text goes to a new file beside the target, readable by root alone
 * while it's written, then takes its mode, then replaces the target in
 * one rename. The target's folder is created when missing.
 * @param {Function} sudo  The host's sudo runner.
 * @param {string} filePath  The target.
 * @param {string|Buffer} content  The file's content.
 * @param {string} mode  Its mode, such as `0644`.
 */
function writeRootFile(sudo, filePath, content, mode) {
  const folder = path.dirname(filePath);
  const temporary = `${filePath}.x1-validator-private-rpc-new`;
  mustSucceed(sudo("mkdir", ["-p", "--", folder]), `Creating ${folder}`);
  mustSucceed(
    sudo("sh", ["-c", 'umask 077 && cat > "$1"', "write", temporary], {
      input: content,
    }),
    `Writing ${temporary}`,
  );
  mustSucceed(
    sudo("chmod", [mode, "--", temporary]),
    `Setting the mode of ${temporary}`,
  );
  mustSucceed(
    sudo("mv", ["-f", "--", temporary, filePath]),
    `Moving ${temporary} to ${filePath}`,
  );
}

/**
 * Makes an http or https GET request and reads the answer as text.
 * @param {typeof http|typeof https} client  node:http or node:https.
 * @param {string} url  The address.
 * @param {number} timeoutMs  How long to wait for an answer.
 * @returns {Promise<{status: number, body: string}>}
 */
function get(client, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = client.get(url, { timeout: timeoutMs }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    request.on("timeout", () => {
      request.destroy(new Error(`No answer from ${url} in ${timeoutMs} ms.`));
    });
    request.on("error", reject);
  });
}

/**
 * Finds a port on 127.0.0.1 that nothing listens on, by asking the
 * system for one and letting it go again.
 * @returns {Promise<number>}
 */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Builds the real host.
 * @param {object} [options]  How to build it.
 * @param {string[]} [options.sudoPrefix]  The command that runs another
 *   as root, with any arguments of its own: `["sudo"]`, unless a test
 *   passes a stand-in.
 * @returns {object} The host's functions.
 */
export function createHost({ sudoPrefix = ["sudo"] } = {}) {
  const run = (command, args, options = {}) =>
    runCommand(command, args, options);
  const sudoArgs = (command, args) => [
    ...sudoPrefix.slice(1),
    "--",
    command,
    ...args,
  ];
  const sudo = (command, args, options = {}) =>
    runCommand(sudoPrefix[0], sudoArgs(command, args), options);
  return {
    run,
    sudo,
    sudoAsync: (command, args) =>
      runCommandAsync(sudoPrefix[0], sudoArgs(command, args)),
    writeRootFile: (filePath, content, mode) =>
      writeRootFile(sudo, filePath, content, mode),
    makeRootDir: (folder, mode) =>
      mustSucceed(
        sudo("install", ["-d", "-m", mode, "--", folder]),
        `Creating ${folder}`,
      ),
    removeRootFile: (filePath) =>
      mustSucceed(sudo("rm", ["-f", "--", filePath]), `Removing ${filePath}`),
    removeRootDir: (folder) =>
      mustSucceed(sudo("rmdir", ["--", folder]), `Removing ${folder}`),
    readText: (filePath) => fs.readFileSync(filePath, "utf8"),
    writeText: (filePath, content) => fs.writeFileSync(filePath, content),
    exists: (filePath) => fs.existsSync(filePath),
    makeTempDir: () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "x1-validator-private-rpc-")),
    removeTempDir: (folder) =>
      fs.rmSync(folder, { recursive: true, force: true }),
    httpGet: (url, timeoutMs) => get(http, url, timeoutMs),
    httpsGet: (url, timeoutMs) => get(https, url, timeoutMs),
    freeLoopbackPort,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    userName: () => os.userInfo().username,
    isRoot: () => process.getuid() === 0,
    nodePath: () => process.execPath,
  };
}
