/**
 * @file x1-validator-private-rpc/src/lib/host.js
 * @description
 * The real host. Every effect the tool has outside its own process goes
 * through these functions:
 *
 * - running commands, with or without sudo
 * - writing and removing files root owns, and files the tool's own
 *   account owns, and reading files
 * - http and https requests, json posts, and https requests to an
 *   address under a hostname, which also report the server's certificate
 * - name lookups, and the machine's own addresses
 * - picking a free port, and pausing
 *
 * Tests pass a stand-in with the same functions instead, so no test
 * touches the machine.
 *
 * The tool runs as the validator's account and never as root. Steps that
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
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mustSucceed } from "./command-result.js";

/**
 * Names the tool in every request it makes. ACME servers require one,
 * by RFC 8555, and the other servers it asks see who's asking.
 */
const USER_AGENT = "x1-validator-private-rpc";

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
    stdio: [
      input === undefined || input === null ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ],
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined && result.error !== null) {
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
 * Runs one command through sudo, and stops with an error naming the step
 * when the command fails.
 * @param {Function} sudo  The host's sudo runner.
 * @param {string} command  The command.
 * @param {string[]} args  Its arguments.
 * @param {string} what  The step, in words, for the error.
 * @param {{input?: string|Buffer}} [options]  What goes to its stdin.
 */
function sudoStep(sudo, command, args, what, options = {}) {
  const result = sudo(command, args, options);
  mustSucceed(result, what);
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
  sudoStep(sudo, "mkdir", ["-p", "--", folder], `Creating ${folder}`);
  sudoStep(
    sudo,
    "sh",
    ["-c", 'umask 077 && cat > "$1"', "write", temporary],
    `Writing ${temporary}`,
    { input: content },
  );
  sudoStep(
    sudo,
    "chmod",
    [mode, "--", temporary],
    `Setting the mode of ${temporary}`,
  );
  sudoStep(
    sudo,
    "mv",
    ["-f", "--", temporary, filePath],
    `Moving ${temporary} to ${filePath}`,
  );
}

/**
 * Writes a file the tool's own account owns, so that no reader ever sees
 * it half written: the text goes to a new file beside the target, which
 * has the target's mode from the start, then replaces the target in one
 * rename.
 * @param {string} filePath  The target.
 * @param {string} content  The file's content.
 * @param {number} mode  Its mode, such as 0o600.
 */
function writeUserFile(filePath, content, mode) {
  const temporary = `${filePath}.x1-validator-private-rpc-new`;
  fs.writeFileSync(temporary, content, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
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
    const options = {
      timeout: timeoutMs,
      headers: { "User-Agent": USER_AGENT },
    };
    const request = client.get(url, options, (response) => {
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
 * Reads a response's body as text.
 * @param {import("node:http").IncomingMessage} response  The response.
 * @returns {Promise<string>}
 */
function readBody(response) {
  return new Promise((resolve) => {
    response.setEncoding("utf8");
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => resolve(body));
  });
}

/**
 * POSTs json, over http or https, and reads the answer as text. An error
 * names only the url's origin, never its path, which may hold a token.
 * @param {string} url  The address.
 * @param {unknown} body  What to send, as json.
 * @param {number} timeoutMs  How long to wait for an answer.
 * @returns {Promise<{status: number, body: string}>}
 */
function postJson(url, body, timeoutMs) {
  const client = url.startsWith("https:") ? https : http;
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": USER_AGENT,
        },
        timeout: timeoutMs,
      },
      (response) =>
        readBody(response).then((text) =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        ),
    );
    request.on("timeout", () => {
      const origin = new URL(url).origin;
      request.destroy(
        new Error(`No answer from ${origin} in ${timeoutMs} ms.`),
      );
    });
    request.on("error", reject);
    request.end(data);
  });
}

/**
 * @typedef {object} TlsAnswer
 * @property {number} status  The http status.
 * @property {string} body  The answer's text.
 * @property {{validTo: number, altNames: string, issuer: string}}
 *   certificate  The server's certificate: when it expires, in
 *   milliseconds since 1970; its subject alternative names; and its
 *   issuer's organization.
 */

/**
 * Makes an https GET request to an address, with the tls server name
 * and the Host header set to a hostname, so nginx answers as it would
 * for that hostname, wherever its dns record points.
 * @param {object} target  Where to ask.
 * @param {string} target.address  The ip address.
 * @param {number} target.port  The port.
 * @param {string} target.hostname  The name to ask under.
 * @param {string} target.path  The path, such as `/x1-rpc-gate`.
 * @param {number} target.timeoutMs  How long to wait.
 * @param {string} [target.ca]  The certificate authorities to trust, in
 *   pem; Node.js's own list unless given.
 * @returns {Promise<TlsAnswer>}
 */
function tlsGet({ address, port, hostname, path: urlPath, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: address,
        port,
        servername: hostname,
        path: urlPath,
        headers: { Host: hostname, "User-Agent": USER_AGENT },
        agent: false,
        timeout: timeoutMs,
        ...(ca === undefined || ca === null ? {} : { ca }),
      },
      (response) => {
        const peer = response.socket.getPeerCertificate();
        const certificate = {
          validTo: Date.parse(peer.valid_to),
          altNames: peer.subjectaltname ?? "",
          issuer: peer.issuer?.O ?? "",
        };
        readBody(response).then((body) =>
          resolve({ status: response.statusCode ?? 0, body, certificate }),
        );
      },
    );
    request.on("timeout", () => {
      request.destroy(
        new Error(`No answer from ${address}:${port} in ${timeoutMs} ms.`),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Lists the ipv4 addresses on the machine's own interfaces.
 * @returns {string[]}
 */
function localIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces)
    .flat()
    .filter((entry) => entry.family === "IPv4")
    .map((entry) => entry.address);
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
 * Removes a folder the tool's own account owns, unless something is
 * still in it.
 * @param {string} folder  The folder.
 * @throws {Error} When the folder is missing or can't be removed, since
 *   only a folder that still holds something is meant to stay.
 */
function removeUserDirIfEmpty(folder) {
  try {
    fs.rmdirSync(folder);
  } catch (error) {
    if (error.code !== "ENOTEMPTY") {
      throw error;
    }
  }
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
    // A group, when given, owns the folder too.
    makeRootDir: (folder, mode, group) => {
      const owner = group === undefined || group === null ? [] : ["-g", group];
      const args = ["-d", "-m", mode, ...owner, "--", folder];
      sudoStep(sudo, "install", args, `Creating ${folder}`);
    },
    removeRootFile: (filePath) =>
      sudoStep(sudo, "rm", ["-f", "--", filePath], `Removing ${filePath}`),
    removeRootDir: (folder) =>
      sudoStep(sudo, "rmdir", ["--", folder], `Removing ${folder}`),
    removeRootDirIfEmpty: (folder) =>
      sudoStep(
        sudo,
        "rmdir",
        ["--ignore-fail-on-non-empty", "--", folder],
        `Removing ${folder}`,
      ),
    removeRootTree: (folder) =>
      sudoStep(
        sudo,
        "rm",
        ["-rf", "--one-file-system", "--", folder],
        `Removing ${folder}`,
      ),
    readText: (filePath) => fs.readFileSync(filePath, "utf8"),
    writeText: (filePath, content) => fs.writeFileSync(filePath, content),
    writeUserFile,
    // A folder that was there already keeps its own mode.
    makeUserDir: (folder, mode) => {
      const made = fs.mkdirSync(folder, { recursive: true, mode });
      if (made !== undefined && made !== null) {
        fs.chmodSync(folder, mode);
      }
    },
    removeUserFile: (filePath) => fs.rmSync(filePath, { force: true }),
    removeUserDirIfEmpty,
    removeUserTree: (folder) =>
      fs.rmSync(folder, { recursive: true, force: true }),
    fileMode: (filePath) => fs.statSync(filePath).mode & 0o777,
    modifiedAt: (filePath) => fs.statSync(filePath).mtimeMs,
    homeDir: () => os.userInfo().homedir,
    exists: (filePath) => fs.existsSync(filePath),
    makeTempDir: () => {
      const tempRoot = os.tmpdir();
      const prefix = path.join(tempRoot, "x1-validator-private-rpc-");
      return fs.mkdtempSync(prefix);
    },
    httpGet: (url, timeoutMs) => get(http, url, timeoutMs),
    httpsGet: (url, timeoutMs) => get(https, url, timeoutMs),
    postJson,
    tlsGet,
    lookupIpv4: async (hostname) =>
      (await dns.lookup(hostname, { family: 4, all: true })).map(
        (entry) => entry.address,
      ),
    localIpv4Addresses,
    freeLoopbackPort,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    userName: () => os.userInfo().username,
    isRoot: () => process.getuid() === 0,
    nodePath: () => process.execPath,
  };
}
