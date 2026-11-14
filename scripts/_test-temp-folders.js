/**
 * @file scripts/_test-temp-folders.js
 * @description
 * Makes the temporary folders tests work in, and clears away the ones
 * left by test runs that died. Each folder sits in the system's
 * temporary folder, named `x1-validator-services-test-<purpose>-<pid>-`
 * followed by random characters, so no two processes ever share one,
 * and the gate can tell a live run's folder from a dead run's by the
 * process id. A test process removes its own folders as it exits; the
 * gate removes, before it runs the tests, the folders of processes that
 * are gone.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "x1-validator-services-test-";

/** The folders this process made, which it removes as it exits. */
const madeFolders = new Set();

/**
 * Removes every folder this process made.
 */
function removeMadeFolders() {
  for (const folder of madeFolders) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Makes a new temporary folder for a test, removed when the process
 * exits.
 * @param {string} purpose  A word or two saying what it's for, such as
 *   `settings`.
 * @returns {string} The folder's absolute path.
 */
export function makeTestTempFolder(purpose) {
  if (madeFolders.size === 0) {
    process.once("exit", removeMadeFolders);
  }
  const tempRoot = os.tmpdir();
  const prefix = path.join(tempRoot, `${PREFIX}${purpose}-${process.pid}-`);
  const folder = fs.mkdtempSync(prefix);
  madeFolders.add(folder);
  return folder;
}

/**
 * Decides whether a process is still running.
 * @param {number} pid  Its id.
 * @returns {boolean}
 */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Removes the test folders, in the system's temporary folder, of
 * processes that are no longer running.
 * @returns {string[]} The folders it removed.
 */
export function removeLeftoverTestTempFolders() {
  const tempRoot = os.tmpdir();
  const removed = [];
  for (const name of fs.readdirSync(tempRoot)) {
    const pid = Number.parseInt(name.split("-").at(-2) ?? "", 10);
    if (name.startsWith(PREFIX) && Number.isInteger(pid) && !isRunning(pid)) {
      const folder = path.join(tempRoot, name);
      fs.rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
    }
  }
  return removed;
}
