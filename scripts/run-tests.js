#!/usr/bin/env node
/**
 * @file scripts/run-tests.js
 * @description
 * Backs `npm test`, `npm run test:coverage` and `npm run test:watch`: the
 * test suite alone, for quick runs while working. `npm run check` is the
 * gate, and the only run that counts before a commit. Run it with
 * `--help` for its usage and exit codes.
 */

import { listTestFiles } from "./_test-files.js";
import { checkScriptArgs, projectRoot, runInherited } from "./_tools.js";

const USAGE = `Usage: node scripts/run-tests.js [--coverage] [--watch]

Runs the test suite alone, for quick runs while working. With
--coverage it adds a coverage summary; with --watch it reruns on every
change. npm run check is the gate.

Exit codes: the test runner's own; 0 when every test passed.`;

/**
 * Runs the suite with the options the arguments name, and exits with the
 * test runner's code.
 */
function main() {
  const args = process.argv.slice(2);
  checkScriptArgs(args, ["--coverage", "--watch"], USAGE);
  const options = [];
  if (args.includes("--coverage")) {
    options.push("--experimental-test-coverage");
  }
  if (args.includes("--watch")) {
    options.push("--watch");
  }
  const files = listTestFiles(projectRoot());
  process.exit(
    runInherited(process.execPath, ["--test", ...options, ...files]),
  );
}

main();
