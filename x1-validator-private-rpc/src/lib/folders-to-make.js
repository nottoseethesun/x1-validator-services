/**
 * @file x1-validator-private-rpc/src/lib/folders-to-make.js
 * @description
 * Finds the folders a write would create, so whatever writes there can
 * take back exactly those folders later. apply records each one before
 * it writes, for undo-apply. The nginx upgrade check puts each one on its
 * undo list.
 */

import path from "node:path";

/**
 * Lists the folders that writing into a folder would create, outermost
 * first.
 * @param {object} host  The host.
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
