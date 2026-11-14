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
 * Removes a folder and everything in it, as `rm -rf` does.
 * @param {Map<string, string|Buffer>} files  The fake's files.
 * @param {string} folder  The folder.
 */
function removeTree(files, folder) {
  for (const name of [...files.keys()]) {
    if (name === folder || name.startsWith(`${folder}/`)) {
      files.delete(name);
    }
  }
}

/**
 * @typedef {object} FakeCall
 * @property {string} kind  `run`, `sudo`, or the name of the file
 *   function called, such as `writeRootFile` or `removeRootDir`.
 * @property {string} [command]  The command, for `run` and `sudo`.
 * @property {string[]} [args]  Its arguments.
 * @property {string} [path]  The file or folder, for the file kinds.
 * @property {string} [mode]  The folder's mode, for `makeRootDir`.
 * @property {string} [group]  The folder's group, for `makeRootDir`, when
 *   given.
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
 * @param {(url: string, body: unknown) => Promise<object>}
 *   [scenario.postJson]  Answers json posts.
 * @param {(target: object) => Promise<object>} [scenario.tlsGet]
 *   Answers https requests to an address under a hostname.
 * @param {Object<string, string[]>} [scenario.dns]  Each hostname's
 *   ipv4 addresses; a name missing here doesn't resolve.
 * @param {string[]} [scenario.addresses]  The machine's own addresses.
 * @returns {object} The fake host, with `calls` listing every call.
 */
export function createFakeHost({
  respond,
  files = new Map(),
  folders = [],
  httpGet = async () => ({ status: 200, body: "unlocked\n" }),
  httpsGet = async () => ({ status: 404, body: "" }),
  postJson = async () => ({ status: 404, body: "" }),
  tlsGet = async () => {
    throw new Error("connect ECONNREFUSED");
  },
  dns = {},
  addresses = ["127.0.0.1"],
}) {
  for (const folder of folders) {
    addFolders(files, folder);
  }
  const calls = [];
  const modes = new Map();
  const modified = new Map();
  let clock = 0;
  const needFile = (filePath) => {
    if (!files.has(filePath)) {
      throw new Error(`ENOENT: no such file, stat '${filePath}'`);
    }
  };
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
    modes,
    modified,
    run: command("run"),
    sudo,
    // Recorded as a `sudo` call, since only the waiting differs.
    sudoAsync: async (name, args) => sudo(name, args),
    writeRootFile: fileCall("writeRootFile", (filePath, content) => {
      addFolders(files, path.dirname(filePath));
      files.set(filePath, content);
    }),
    // Records the mode and the group too, since they decide who may look.
    makeRootDir: (folder, mode, group) => {
      calls.push({ kind: "makeRootDir", path: folder, mode, group });
      addFolders(files, folder);
    },
    removeRootFile: fileCall("removeRootFile", (filePath) =>
      files.delete(filePath),
    ),
    removeRootDir: fileCall("removeRootDir", (folder) =>
      removeEmptyFolder(files, folder),
    ),
    removeRootDirIfEmpty: fileCall("removeRootDirIfEmpty", (folder) => {
      if (![...files.keys()].some((name) => name.startsWith(`${folder}/`))) {
        files.delete(folder);
      }
    }),
    removeRootTree: fileCall("removeRootTree", (folder) =>
      removeTree(files, folder),
    ),
    readText: (filePath) => {
      if (!files.has(filePath)) {
        throw new Error(`ENOENT: no such file, open '${filePath}'`);
      }
      return String(files.get(filePath));
    },
    writeText: (filePath, content) => files.set(filePath, content),
    writeUserFile: fileCall("writeUserFile", (filePath, content, mode) => {
      addFolders(files, path.dirname(filePath));
      files.set(filePath, content);
      modes.set(filePath, mode);
      modified.set(filePath, clock);
    }),
    // A folder that was there already keeps its own mode, as on the host.
    makeUserDir: fileCall("makeUserDir", (folder, mode) => {
      if (!files.has(folder)) {
        modes.set(folder, mode);
      }
      addFolders(files, folder);
    }),
    removeUserFile: fileCall("removeUserFile", (filePath) =>
      files.delete(filePath),
    ),
    removeUserDirIfEmpty: fileCall("removeUserDirIfEmpty", (folder) => {
      needFile(folder);
      if (![...files.keys()].some((name) => name.startsWith(`${folder}/`))) {
        files.delete(folder);
      }
    }),
    // Unrecorded, like makeTempDir: it changes only the account's files.
    removeUserTree: (folder) => removeTree(files, folder),
    fileMode: (filePath) => {
      needFile(filePath);
      return modes.get(filePath) ?? 0o644;
    },
    modifiedAt: (filePath) => {
      needFile(filePath);
      return modified.get(filePath) ?? 0;
    },
    homeDir: () => "/home/validator",
    exists: (filePath) => files.has(filePath),
    makeTempDir: () => "/tmp/fake-temp",
    httpGet,
    httpsGet,
    postJson,
    tlsGet,
    lookupIpv4: async (hostname) => {
      if (!Object.hasOwn(dns, hostname)) {
        throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      }
      return dns[hostname];
    },
    localIpv4Addresses: () => addresses,
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
