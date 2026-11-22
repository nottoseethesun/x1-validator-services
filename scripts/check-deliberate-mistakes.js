#!/usr/bin/env node
/**
 * @file scripts/check-deliberate-mistakes.js
 * @description
 * `npm run test:mistakes`, and the gate's last stage: it makes each
 * feature's deliberate mistakes in its code, in memory only, each in a
 * process of its own, side by side, as many at once as the machine has
 * processors, and checks that a test fails for each, as
 * scripts/_deliberate-mistakes.js describes. Run it with `--help` for its
 * usage, examples and exit codes.
 */

import os from "node:os";
import { checkDeliberateMistakes } from "./_deliberate-mistakes.js";
import { projectRoot, requireMinNode, scriptProgram } from "./_tools.js";
import { FEATURES } from "./lint-targets.js";

/**
 * Checks every feature's deliberate mistakes, and exits with the verdict.
 * @returns {Promise<void>}
 */
async function main() {
  scriptProgram(
    "scripts/check-deliberate-mistakes.js",
    "Checks that the tests catch the deliberate mistakes each feature " +
      "lists in its test/deliberate-mistakes.json: small changes to its " +
      "code, of the kind a slip in an edit would make. It makes each in " +
      "memory only, and runs the test file its entry names, in a process of " +
      "its own. That test file must fail. The runs go side by side.",
    {
      examples: [
        "npm run test:mistakes",
        "    Runs the deliberate mistakes alone, without the rest of the",
        "    gate, such as after adding a mistake to a feature's list.",
      ],
      exitCodes: [
        "0  a test failed for every mistake",
        "1  a mistake's test file passed with the mistake made",
        "   or a mistake's test file never loaded the file the mistake",
        "     changes",
        '   or an entry is wrong, such as its "from" text not being in its',
        "     file, or being there more than once",
        "   or a test file an entry names fails with no mistake made",
      ],
    },
  ).parse();
  requireMinNode("scripts/check-deliberate-mistakes.js");
  const passed = await checkDeliberateMistakes({
    root: projectRoot(),
    features: FEATURES,
    concurrency: os.availableParallelism(),
  });
  process.exit(passed === true ? 0 : 1);
}

main();
