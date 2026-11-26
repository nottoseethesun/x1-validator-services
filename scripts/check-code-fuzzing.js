#!/usr/bin/env node
/**
 * @file scripts/check-code-fuzzing.js
 * @description
 * `npm run test:fuzzing`, and the gate's last stage, code-fuzzing: it
 * makes each feature's code-fuzzing changes in its code, in memory only,
 * each in a process of its own, side by side, as many at once as the
 * machine has processors, and checks that a test fails for each, as
 * scripts/_code-fuzzing.js describes. Run it with `--help` for its usage,
 * examples and exit codes.
 */

import os from "node:os";
import { checkCodeFuzzing } from "./_code-fuzzing.js";
import { projectRoot, requireMinNode, scriptProgram } from "./_tools.js";
import { FEATURES } from "./lint-targets.js";

/**
 * Checks every feature's code-fuzzing changes, and exits with the verdict.
 * @returns {Promise<void>}
 */
async function main() {
  scriptProgram(
    "scripts/check-code-fuzzing.js",
    "Code-fuzzing: checks that the tests catch the changes each feature " +
      "lists in its test/code-fuzzing.json, small changes to its code, of " +
      "the kind a slip in an edit would make. It makes each in memory only, " +
      "and runs the test file its entry names, in a process of its own. " +
      "That test file must fail. A change's run still going after 5 " +
      "minutes is stopped, and counts as caught. The runs go side by side.",
    {
      examples: [
        "npm run test:fuzzing",
        "    Runs code-fuzzing alone, such as after adding a change to a",
        "    feature's list, without the rest of the gate, npm run check,",
        "    which must pass before every commit.",
      ],
      exitCodes: [
        "0  every change was caught",
        "1  a change's test file passed with the change made",
        "   or a change's test file never loaded the file the change",
        "     edits",
        '   or an entry is wrong, such as its "from" text not being in its',
        "     file, or being there more than once",
        "   or a test file an entry names fails with no change made",
      ],
    },
  ).parse();
  requireMinNode("scripts/check-code-fuzzing.js");
  const passed = await checkCodeFuzzing({
    root: projectRoot(),
    features: FEATURES,
    concurrency: os.availableParallelism(),
  });
  process.exit(passed === true ? 0 : 1);
}

main();
