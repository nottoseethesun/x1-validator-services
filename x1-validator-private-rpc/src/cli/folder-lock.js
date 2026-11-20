/**
 * @file x1-validator-private-rpc/src/cli/folder-lock.js
 * @description
 * Runs a change while holding flock's lock on a folder, which the host
 * keeps until the change ends, or until the command ends, even when it's
 * killed. The start script's lock and the api keys' lock both use it.
 */

/**
 * Runs a change while holding a folder's lock.
 * @template T
 * @param {object} host  The host.
 * @param {string} folder  The folder, which must exist.
 * @param {string} lockedMessage  What the error says when another command
 *   holds the lock.
 * @param {() => T|Promise<T>} change  The change.
 * @returns {Promise<T>} What the change returns.
 * @throws {Error} When another command holds the lock, before the change
 *   starts, since that command's change and this one would undo each
 *   other.
 */
export async function withFolderLock(host, folder, lockedMessage, change) {
  const release = host.lockFolder(folder);
  if (release === undefined || release === null) {
    throw new Error(lockedMessage);
  }
  try {
    return await change();
  } finally {
    release();
  }
}
