#!/usr/bin/env node
/**
 * @file scripts/audit.js
 * @description
 * Backs `npm run audit:security` and `npm run audit:secrets`: the
 * security lint and the secret scan on their own, the same stages
 * `npm run lint` and the gate run. Run it with `--help` for its options
 * and exit codes.
 */

import { Option } from "commander";
import { secretlintStage, securityLintStage } from "./_gate-stages.js";
import { runInherited, scriptProgram } from "./_tools.js";

/**
 * Runs the pass the option names, and exits with its code.
 */
function main() {
  const program = scriptProgram(
    "scripts/audit.js",
    "Runs the security lint, or the secret scan.",
    ["0  clean", "1  bad arguments, or a problem found"],
  )
    .addOption(
      new Option("--security", "run the security lint").conflicts("secrets"),
    )
    .option("--secrets", "run the secret scan");
  program.parse();
  const { security, secrets } = program.opts();
  if (security !== true && secrets !== true) {
    program.error("error: give --security or --secrets.");
  }
  const stage = security === true ? securityLintStage() : secretlintStage();
  const code = runInherited(stage.command, stage.args);
  process.exit(code);
}

main();
