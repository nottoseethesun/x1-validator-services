/**
 * @file x1-validator-private-rpc/test/helpers/fake-host.js
 * @description
 * A stand-in for the real host (src/lib/host.js), with the same
 * functions, for tests. Commands go to a `respond` function the test
 * writes, which answers each one as the test's scenario needs; files
 * live in a map, where writing a file or making a folder also creates
 * every missing folder above it, and removing a folder that still holds
 * anything fails, as on the real host; requests go to functions the test
 * gives. Every call is recorded in order, so a test can check what was
 * done and in what order. Nothing touches the machine.
 */

import path from "node:path";

/**
 * Adds a folder and every folder above it, as `mkdir -p` does.
 * @param {Map<string, string|Buffer>} files  The fake's files.
 * @param {string} folder  The folder.
 */
function addFolders(files, folder) {
  for (let f = folder; f !== path.dirname(f); f = path.dirname(f)) {
    files.set(f, "");
  }
}

/**
 * Removes an empty folder, as `rmdir` does.
 * @param {Map<string, string|Buffer>} files  The fake's files.
 * @param {string} folder  The folder.
 * @throws {Error} When the folder still holds anything.
 */
function removeEmptyFolder(files, folder) {
  if ([...files.keys()].some((name) => name.startsWith(`${folder}/`))) {
    throw new Error(`rmdir: failed to remove '${folder}': Directory not empty`);
  }
  files.delete(folder);
}

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
 * @param {string[]} [scenario.folders]  Folders that exist at the start,
 *   each with every folder above it; added to `files`.
 * @param {(url: string) => Promise<object>} [scenario.httpGet]  Answers
 *   http requests.
 * @param {(url: string) => Promise<object>} [scenario.httpsGet]  Answers
 *   https requests.
 * @returns {object} The fake host, with `calls` listing every call.
 */
export function createFakeHost({
  respond,
  files = new Map(),
  folders = [],
  httpGet = async () => ({ status: 200, body: "unlocked\n" }),
  httpsGet = async () => ({ status: 404, body: "" }),
}) {
  for (const folder of folders) {
    addFolders(files, folder);
  }
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
      addFolders(files, path.dirname(filePath));
      files.set(filePath, content);
    }),
    makeRootDir: fileCall("makeRootDir", (folder) => addFolders(files, folder)),
    removeRootFile: fileCall("removeRootFile", (filePath) =>
      files.delete(filePath),
    ),
    removeRootDir: fileCall("removeRootDir", (folder) =>
      removeEmptyFolder(files, folder),
    ),
    readText: (filePath) => {
      if (!files.has(filePath)) {
        throw new Error(`ENOENT: no such file, open '${filePath}'`);
      }
      return String(files.get(filePath));
    },
    writeText: (filePath, content) => files.set(filePath, content),
    exists: (filePath) => files.has(filePath),
    makeTempDir: () => "/tmp/fake-temp",
    removeTempDir: (folder) => {
      for (const name of [...files.keys()]) {
        if (name.startsWith(`${folder}/`)) {
          files.delete(name);
        }
      }
    },
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
