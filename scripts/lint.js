#!/usr/bin/env node
/**
 * @file scripts/lint.js
 * @description
 * Backs `npm run lint` and `npm run lint:fix`, and so the pre-commit hook,
 * which runs `npm run lint` and nothing else. It runs the gate's lint,
 * format, dead-code and security checks, without the tests and the
 * dependency audits, in the order scripts/_gate-stages.js gives, then
 * prints a summary. With `--fix`, each tool rewrites what it can fix and
 * reports the rest.
 *
 * Like every script, it needs Node.js 24 or newer. Run it with
 * `--help` for its usage, examples and exit codes.
 */

import { lintStages } from "./_gate-stages.js";
import { printSummary, runStages } from "./_run-stages.js";
import { requireMinNode, scriptProgram } from "./_tools.js";

/**
 * Runs the lint stages and exits with the verdict.
 */
function main() {
  const program = scriptProgram(
    "scripts/lint.js",
    "Runs the gate's lint, format, dead-code and security checks, without " +
      "the tests and the dependency audits.",
    {
      examples: [
        "npm run lint",
        "    What the git pre-commit hook runs before each commit.",
        "npm run lint:fix",
        "    Has each tool rewrite what it can fix, such as the formatting,",
        "    and report the rest.",
      ],
      exitCodes: ["0  every check passed", "1  at least one check failed"],
    },
  ).option("--fix", "have each tool rewrite what it can fix", false);
  program.parse();
  requireMinNode("scripts/lint.js");
  const { fix } = program.opts();
  const results = runStages(lintStages({ fix: fix === true }));
  const passed = printSummary(results);
  process.exit(passed === true ? 0 : 1);
}

main();
