#!/usr/bin/env node
/**
 * @file scripts/check-unused-src-modules.js
 * @description
 * The gate's check that every source module is loaded by an entry point,
 * not only by tests. See scripts/_unused-src-modules.js for why knip
 * alone can't catch this. Run it with `--help` for its usage and exit
 * codes.
 */

import { entryPointFiles, moduleFiles } from "./_project-files.js";
import { checkScriptArgs, projectRoot } from "./_tools.js";
import { findUnusedSrcModules } from "./_unused-src-modules.js";

const USAGE = `Usage: node scripts/check-unused-src-modules.js

Fails when a module under a feature's src/ is loaded by no entry point.

Exit codes:
  0  every source module is reached from an entry point
  1  at least one isn't; each is listed`;

/**
 * Walks from the entry points and reports the modules never reached.
 */
async function main() {
  checkScriptArgs(process.argv.slice(2), [], USAGE);
  const root = projectRoot();
  const entries = entryPointFiles(root);
  const modules = moduleFiles(root);
  const unused = await findUnusedSrcModules(root, entries, modules);
  if (unused.length === 0) {
    console.log(
      `All ${modules.length} source modules are loaded by the ` +
        `${entries.length} entry points.`,
    );
    return;
  }
  console.error("No entry point loads these modules:");
  for (const file of unused) {
    console.error(`  ${file}`);
  }
  console.error(
    "Import each one from the code that needs it, or delete it. A new " +
      "program that is started by its path goes in an entry point place " +
      "that scripts/lint-targets.js names.",
  );
  process.exitCode = 1;
}

await main();
