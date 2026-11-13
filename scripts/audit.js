#!/usr/bin/env node
/**
 * @file scripts/audit.js
 * @description
 * Backs `npm run audit:security` and `npm run audit:secrets`: the
 * security lint and the secret scan on their own, the same stages
 * `npm run lint` and the gate run. Run it with `--help` for its usage
 * and exit codes.
 */

import { secretlintStage, securityLintStage } from "./_gate-stages.js";
import { checkScriptArgs, runInherited } from "./_tools.js";

const USAGE = `Usage: node scripts/audit.js --security|--secrets

Runs the security lint (--security) or the secret scan (--secrets).

Exit codes:
  0  clean
  1  bad arguments, or a problem found`;

/**
 * Runs the pass the argument names, and exits with its code.
 */
function main() {
  const args = process.argv.slice(2);
  checkScriptArgs(args, ["--security", "--secrets"], USAGE);
  if (args.length !== 1) {
    console.error(USAGE);
    process.exit(1);
  }
  const stage =
    args[0] === "--security" ? securityLintStage() : secretlintStage();
  process.exit(runInherited(stage.command, stage.args));
}

main();
