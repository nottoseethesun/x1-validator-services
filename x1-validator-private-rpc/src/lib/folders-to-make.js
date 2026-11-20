/**
 * @file x1-validator-private-rpc/src/lib/folders-to-make.js
 * @description
 * Finds the folders a write would create, so whatever writes there can
 * take back exactly those folders later. apply records each one before
 * it writes, for undo-apply. The nginx upgrade check puts each one on its
 * undo list. Root can do the looking, for a path inside a folder only
 * root can look into, where the validator's account sees nothing.
 */

import path from "node:path";

/**
 * Lists the folders that writing into a folder would create, outermost
 * first.
 * @param {{exists: (path: string) => boolean}} host  The host, or
 *   anything that says whether a path exists, such as one that asks root.
 * @param {string} folder  The folder written into.
 * @returns {string[]}
 */
export function foldersToMake(host, folder) {
  const missing = [];
  let current = folder;
  while (!host.exists(current) && current !== path.dirname(current)) {
    missing.unshift(current);
    current = path.dirname(current);
  }
  return missing;
}

/**
 * Lets root say whether a path exists, through sudo, since the account
 * can't see into a folder only root can look into.
 * @param {object} host  The host.
 * @returns {{exists: (path: string) => boolean}}
 */
export function rootLooks(host) {
  return {
    exists: (each) => host.sudo("test", ["-e", each]).status === 0,
  };
}
