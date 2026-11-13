/**
 * @file scripts/_unused-src-modules.js
 * @description
 * Finds source modules that no entry point loads. knip fails a file that
 * nothing imports, but a module imported only by tests passes it, since
 * knip counts tests as entry points. This walk starts from the entry
 * points alone, with madge, and reports every source module it never
 * reaches: code that runs in the tests and never on the validator.
 */

import path from "node:path";
import madge from "madge";

/**
 * Lists the source modules the walk from the entry points never reaches.
 * @param {string} root  The project's root.
 * @param {string[]} entryFiles  The entry points, relative to the root.
 * @param {string[]} srcFiles  The source modules, relative to the root.
 * @returns {Promise<string[]>} The modules not reached, in the order
 *   given.
 */
export async function findUnusedSrcModules(root, entryFiles, srcFiles) {
  if (entryFiles.length === 0) {
    return [...srcFiles];
  }
  const graph = await madge(
    entryFiles.map((file) => path.join(root, file)),
    { baseDir: root, fileExtensions: ["js"] },
  );
  const reached = new Set();
  for (const [file, dependencies] of Object.entries(graph.obj())) {
    reached.add(file);
    for (const dependency of dependencies) {
      reached.add(dependency);
    }
  }
  return srcFiles.filter((file) => !reached.has(file));
}
