/**
 * @file x1-validator-private-rpc/test/helpers/fake-host.js
 * @description
 * A stand-in for the real host (src/lib/host.js), with the same
 * functions, for tests. Commands go to a `respond` function the test
 * writes, which answers each one as the test's scenario needs; files
 * live in a map, where writing a file also creates its folder, as the
 * real host does; requests go to functions the test gives. Every call is
 * recorded in order, so a test can check what was done and in what
 * order. Nothing touches the machine.
 */

import path from "node:path";

/**
 * @typedef {object} FakeCall
 * @property {string} kind  `run`, `sudo`, `writeRootFile`,
 *   `makeRootDir`, `removeRootFile` or `removeRootDir`.
 * @property {string} [command]  The command, for `run` and `sudo`.
 * @property {string[]} [args]  Its arguments.
 * @property {string} [path]  The file or folder, for the file kinds.
 */

/**
 * Builds a fake host.
 * @param {object} scenario  How the fake answers.
 * @param {(call: FakeCall) => object|undefined} scenario.respond
 *   Answers a command with `{status, stdout, stderr}`; undefined means
 *   success with no output.
 * @param {Map<string, string|Buffer>} [scenario.files]  The files that
 *   exist, and their content; changed as the code writes and removes.
 * @param {(url: string) => Promise<object>} [scenario.httpGet]  Answers
 *   http requests.
 * @param {(url: string) => Promise<object>} [scenario.httpsGet]  Answers
 *   https requests.
 * @returns {object} The fake host, with `calls` listing every call.
 */
export function createFakeHost({
  respond,
  files = new Map(),
  httpGet = async () => ({ status: 200, body: "unlocked\n" }),
  httpsGet = async () => ({ status: 404, body: "" }),
}) {
  const calls = [];
  let clock = 0;
  const command =
    (kind) =>
    (name, args, options = {}) => {
      const call = { kind, command: name, args, input: options.input };
      calls.push(call);
      return { status: 0, stdout: "", stderr: "", ...respond(call) };
    };
  const fileCall =
    (kind, change) =>
    (filePath, ...rest) => {
      calls.push({ kind, path: filePath });
      change(filePath, ...rest);
    };
  const sudo = command("sudo");
  return {
    calls,
    files,
    run: command("run"),
    sudo,
    // Recorded as a `sudo` call, since only the waiting differs.
    sudoAsync: async (name, args) => sudo(name, args),
    writeRootFile: fileCall("writeRootFile", (filePath, content) => {
      files.set(path.dirname(filePath), "");
      files.set(filePath, content);
    }),
    makeRootDir: fileCall("makeRootDir", (folder) => files.set(folder, "")),
    removeRootFile: fileCall("removeRootFile", (filePath) =>
      files.delete(filePath),
    ),
    removeRootDir: fileCall("removeRootDir", (folder) => files.delete(folder)),
    readText: (filePath) => {
      if (!files.has(filePath)) {
        throw new Error(`ENOENT: no such file, open '${filePath}'`);
      }
      return String(files.get(filePath));
    },
    writeText: (filePath, content) => files.set(filePath, content),
    exists: (filePath) => files.has(filePath),
    makeTempDir: () => "/tmp/fake-temp",
    removeTempDir: () => {},
    httpGet,
    httpsGet,
    freeLoopbackPort: async () => 18080,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    userName: () => "validator",
    isRoot: () => false,
    nodePath: () => "/usr/bin/node",
  };
}
