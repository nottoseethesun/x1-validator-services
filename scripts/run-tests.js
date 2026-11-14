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
import { projectRoot, runInherited, scriptProgram } from "./_tools.js";

/**
 * Runs the suite with the options the arguments name, and exits with the
 * test runner's code.
 */
function main() {
  const program = scriptProgram(
    "scripts/run-tests.js",
    "Runs the test suite alone, for quick runs while working. " +
      "npm run check is the gate.",
    ["the test runner's own; 0 when every test passed"],
  )
    .option("--coverage", "add a coverage summary")
    .option("--watch", "run the tests again on every change");
  program.parse();
  const { coverage, watch } = program.opts();
  const options = [];
  if (coverage === true) {
    options.push("--experimental-test-coverage");
  }
  if (watch === true) {
    options.push("--watch");
  }
  const root = projectRoot();
  const files = listTestFiles(root);
  const code = runInherited(process.execPath, ["--test", ...options, ...files]);
  process.exit(code);
}

main();
