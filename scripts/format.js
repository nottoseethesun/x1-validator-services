#!/usr/bin/env node
/**
 * @file scripts/format.js
 * @description
 * Backs `npm run format` and `npm run format:check`: Prettier over the
 * project's JavaScript files, the same stage `npm run lint` runs. Run
 * `npm run format` to fix a JavaScript formatting failure from the lint
 * or the gate, and `npm run lint:fix` for json or yaml; nothing rewrites
 * files at commit time. Run it with `--help` for its options and exit
 * codes.
 */

import { Option } from "commander";
import { prettierStage } from "./_gate-stages.js";
import { runInherited, scriptProgram } from "./_tools.js";

/**
 * Runs Prettier in the mode the option names, and exits with its code.
 */
function main() {
  const program = scriptProgram(
    "scripts/format.js",
    "Checks, or rewrites, the formatting of the project's JavaScript files.",
    [
      "0  every file is formatted, or was rewritten",
      "1  bad arguments, or unformatted files",
    ],
  )
    .addOption(
      new Option("--check", "report unformatted files").conflicts("write"),
    )
    .option("--write", "rewrite unformatted files");
  program.parse();
  const { check, write } = program.opts();
  if (check !== true && write !== true) {
    program.error("error: give --check or --write.");
  }
  const stage = prettierStage("js", { write: write === true });
  const code = runInherited(stage.command, stage.args);
  process.exit(code);
}

main();
