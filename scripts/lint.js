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
 * The tools need Node.js 24 or newer; see scripts/check.js. Run it with
 * `--help` for its usage and exit codes.
 */

import { lintStages } from "./_gate-stages.js";
import { printSummary, runStages } from "./_run-stages.js";
import { checkScriptArgs } from "./_tools.js";

const USAGE = `Usage: node scripts/lint.js [--fix]

Runs every lint, format and security check that needs nothing but this
machine. With --fix, each tool rewrites what it can fix.

Exit codes:
  0  every check passed
  1  at least one check failed`;

/**
 * Runs the lint stages and exits with the verdict.
 */
function main() {
  const args = process.argv.slice(2);
  checkScriptArgs(args, ["--fix"], USAGE);
  const passed = printSummary(
    runStages(lintStages({ fix: args.includes("--fix") })),
  );
  process.exit(passed ? 0 : 1);
}

main();
