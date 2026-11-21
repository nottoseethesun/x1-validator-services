#!/usr/bin/env node
/**
 * @file scripts/check-deliberate-mistakes.js
 * @description
 * `npm run test:mistakes`, and the gate's last stage: it makes each
 * feature's deliberate mistakes in its code, one at a time and in memory
 * only, and checks that a test fails for each, as
 * scripts/_deliberate-mistakes.js describes. Run it with `--help` for its
 * usage and exit codes.
 */

import os from "node:os";
import { checkDeliberateMistakes } from "./_deliberate-mistakes.js";
import { projectRoot, scriptProgram } from "./_tools.js";
import { FEATURES } from "./lint-targets.js";

/**
 * Checks every feature's deliberate mistakes, and exits with the verdict.
 * @returns {Promise<void>}
 */
async function main() {
  scriptProgram(
    "scripts/check-deliberate-mistakes.js",
    "Makes each feature's deliberate mistakes in its code, one at a time " +
      "and in memory only, and checks that a test fails for each. Needs " +
      "Node.js 22.15 or newer.",
    [
      "0  a test failed for every mistake",
      "1  a mistake passed every test, an entry is wrong, or a test fails " +
        "with no mistake made",
    ],
  ).parse();
  const passed = await checkDeliberateMistakes({
    root: projectRoot(),
    features: FEATURES,
    concurrency: os.availableParallelism(),
  });
  process.exit(passed === true ? 0 : 1);
}

main();
