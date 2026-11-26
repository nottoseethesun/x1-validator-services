#!/usr/bin/env node
/**
 * @file scripts/run-tests.js
 * @description
 * Backs `npm test`, `npm run test:coverage` and `npm run test:watch`: the
 * test suite alone, for quick runs while working. `npm run check` is the
 * gate, and the only run that counts before a commit. Run it with
 * `--help` for its usage, examples and exit codes.
 */

import { listTestFiles, TEST_TIMEOUT } from "./_test-files.js";
import {
  projectRoot,
  requireMinNode,
  runInherited,
  scriptProgram,
} from "./_tools.js";

/**
 * Runs the suite with the options the arguments name, and exits with the
 * test runner's code.
 */
function main() {
  const program = scriptProgram(
    "scripts/run-tests.js",
    "Runs every test, and nothing else, for quick runs while working. " +
      "Before a commit, run the gate, npm run check, which runs these tests " +
      "and every other check that must pass.",
    {
      examples: [
        "npm test",
        "    Runs every test once, such as after a change, before the gate.",
        "npm run test:coverage",
        "    The same, with a summary of how much of the code the tests",
        "    ran.",
        "npm run test:watch",
        "    Runs the tests again each time a file changes, until Ctrl-C.",
      ],
      exitCodes: ["the test runner's own, which is 0 when every test passed"],
    },
  )
    .option("--coverage", "add a coverage summary", false)
    .option("--watch", "run the tests again on every change", false);
  program.parse();
  requireMinNode("scripts/run-tests.js");
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
  const code = runInherited(process.execPath, [
    "--test",
    TEST_TIMEOUT,
    ...options,
    ...files,
  ]);
  process.exit(code);
}

main();
