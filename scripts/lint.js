#!/usr/bin/env node
/**
 * @file scripts/lint.js
 * @description
 * Backs `npm run lint` and `npm run lint:fix`, and so the pre-commit hook,
 * which runs `npm run lint` and nothing else. It runs every lint, format
 * and security check that needs nothing but this machine, in the order
 * scripts/_gate-stages.js gives, then prints a summary. With `--fix`, each
 * tool rewrites what it can fix and reports the rest.
 *
 * The tools need Node.js 22.13 or newer; see scripts/check.js. Run it with
 * `--help` for its usage and exit codes.
 */

import { lintStages } from "./_gate-stages.js";
import { printSummary, runStages } from "./_run-stages.js";
import { scriptProgram } from "./_tools.js";

/**
 * Runs the lint stages and exits with the verdict.
 */
function main() {
  const program = scriptProgram(
    "scripts/lint.js",
    "Runs every lint, format and security check that needs nothing but " +
      "this machine.",
    ["0  every check passed", "1  at least one check failed"],
  ).option("--fix", "have each tool rewrite what it can fix");
  program.parse();
  const { fix } = program.opts();
  const results = runStages(lintStages({ fix: fix === true }));
  const passed = printSummary(results);
  process.exit(passed ? 0 : 1);
}

main();
