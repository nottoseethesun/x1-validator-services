#!/usr/bin/env node
/**
 * @file scripts/audit.js
 * @description
 * Backs the four `npm run audit:` targets, each of which runs one of the
 * project's security checks on its own: `audit:security` the security
 * lint, `audit:secrets` the secret scan, `audit:deps` the audit of the
 * shipped dependencies, and `audit:deps:all` the audit of every
 * dependency. It takes each check's command from scripts/_gate-stages.js,
 * as the gate does. Run it with `--help` for its options, examples and
 * exit codes.
 */

import {
  auditAllStage,
  auditShippedStage,
  secretlintStage,
  securityLintStage,
} from "./_gate-stages.js";
import { requireMinNode, runInherited, scriptProgram } from "./_tools.js";

/**
 * Runs the check the option names, and exits with its code.
 */
function main() {
  const program = scriptProgram(
    "scripts/audit.js",
    "Runs one of the project's security checks on its own, such as to " +
      "rerun a check after you fix what it found: the security lint, the " +
      "secret scan, or an audit of the dependencies for known flaws.",
    {
      examples: [
        "npm run audit:security",
        "    ESLint with the security rules, over the project's scripts and",
        "    the code that runs on the validator.",
        "npm run audit:secrets",
        "    Looks for a credential, such as a key or a token, in the files.",
        "npm run audit:deps",
        "    Audits the dependencies the validator installs, and fails on a",
        "    high or critical advisory. The gate, npm run check, which must",
        "    pass before every commit, runs it too, and so does the Security",
        "    Audit workflow on GitHub.",
        "npm run audit:deps:all",
        "    The same, over every dependency, the development tools'",
        "    included.",
      ],
      exitCodes: ["0  clean", "1  bad arguments, or a problem found"],
    },
  )
    .option("--security", "run the security lint", false)
    .option("--secrets", "run the secret scan", false)
    .option(
      "--deps",
      "audit the shipped dependencies, failing on a high or critical advisory",
      false,
    )
    .option(
      "--deps-all",
      "audit every dependency, the development tools' included, the same way",
      false,
    );
  program.parse();
  requireMinNode("scripts/audit.js");
  const { security, secrets, deps, depsAll } = program.opts();
  const chosen = [
    [security, securityLintStage],
    [secrets, secretlintStage],
    [deps, auditShippedStage],
    [depsAll, auditAllStage],
  ].filter(([given]) => given === true);
  if (chosen.length !== 1) {
    program.error(
      "error: give one of --security, --secrets, --deps or --deps-all.",
    );
  }
  const [[, makeStage]] = chosen;
  const stage = makeStage();
  process.exit(runInherited(stage.command, stage.args));
}

main();
