/**
 * @file scripts/_project-files.js
 * @description
 * Lists the kinds of file the dead-code and coverage checks reason
 * about. Entry points are the programs a person or a scheduler starts by
 * their path, in the places scripts/lint-targets.js names. Modules are
 * the files entry points load: the files in folders under a feature's
 * `src/`, and the files of a standalone tool's folder other than its
 * `index.js`. Installed files are the ones a feature copies into another
 * program, such as nginx's njs modules; no entry point loads them.
 */

import path from "node:path";
import { listFilesUnder } from "./_tools.js";
import {
  ENTRY_POINT_PLACES,
  FEATURES,
  INSTALLED_FOLDERS,
} from "./lint-targets.js";

/**
 * Decides whether a file matches an entry point place's pattern.
 * @param {string} file  The file, relative to the project's root.
 * @param {string} folder  The place's folder.
 * @param {string} pattern  `*.js` or `* /index.js` (without the space).
 * @returns {boolean}
 * @throws {Error} For any other pattern, since a pattern this function
 *   can't read would otherwise match nothing without a word.
 */
function matchesEntryPattern(file, folder, pattern) {
  if (!file.endsWith(".js")) {
    return false;
  }
  if (pattern === "*.js") {
    return path.dirname(file) === folder;
  }
  if (pattern === "*/index.js") {
    return (
      path.basename(file) === "index.js" &&
      path.dirname(path.dirname(file)) === folder
    );
  }
  throw new Error(`Unknown entry point pattern: ${pattern}`);
}

/**
 * Lists every entry point, sorted.
 * @param {string} root  The project's root.
 * @returns {string[]} The files' paths, relative to the root.
 */
export function entryPointFiles(root) {
  return ENTRY_POINT_PLACES.flatMap(({ folder, pattern }) =>
    listFilesUnder(root, folder).filter((file) =>
      matchesEntryPattern(file, folder, pattern),
    ),
  ).sort();
}

/**
 * Decides whether a file sits in one of the installed-file folders.
 * @param {string} file  The file, relative to the project's root.
 * @returns {boolean}
 */
function isInstalled(file) {
  return INSTALLED_FOLDERS.some((folder) => file.startsWith(`${folder}/`));
}

/**
 * Lists every module, sorted: what entry points load.
 * @param {string} root  The project's root.
 * @returns {string[]} The files' paths, relative to the root.
 */
export function moduleFiles(root) {
  const entries = new Set(entryPointFiles(root));
  return FEATURES.flatMap((feature) => [
    ...listFilesUnder(root, `${feature}/src`),
    ...listFilesUnder(root, `${feature}/util`),
  ])
    .filter(
      (file) =>
        file.endsWith(".js") && !entries.has(file) && !isInstalled(file),
    )
    .sort();
}

/**
 * Lists every installed file, sorted.
 * @param {string} root  The project's root.
 * @returns {string[]} The files' paths, relative to the root.
 */
export function installedFiles(root) {
  return INSTALLED_FOLDERS.flatMap((folder) =>
    listFilesUnder(root, folder).filter((file) => file.endsWith(".js")),
  ).sort();
}
