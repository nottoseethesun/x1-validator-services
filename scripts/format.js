#!/usr/bin/env node
/**
 * @file scripts/format.js
 * @description
 * Backs `npm run format` and `npm run format:check`: Prettier over the
 * project's JavaScript files, the same stage `npm run lint` runs. Run
 * `npm run format` to fix a formatting failure from the lint or the
 * gate; nothing rewrites files at commit time. Run it with `--help` for
 * its usage and exit codes.
 */

import { prettierStage } from "./_gate-stages.js";
import { checkScriptArgs, runInherited } from "./_tools.js";

const USAGE = `Usage: node scripts/format.js --check|--write

Checks, or rewrites, the formatting of the project's JavaScript files.

Exit codes:
  0  every file is formatted, or was rewritten
  1  bad arguments, or unformatted files`;

/**
 * Runs Prettier in the mode the argument names, and exits with its code.
 */
function main() {
  const args = process.argv.slice(2);
  checkScriptArgs(args, ["--check", "--write"], USAGE);
  if (args.length !== 1) {
    console.error(USAGE);
    process.exit(1);
  }
  const stage = prettierStage("js", { write: args[0] === "--write" });
  process.exit(runInherited(stage.command, stage.args));
}

main();
