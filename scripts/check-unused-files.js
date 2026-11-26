#!/usr/bin/env node
/**
 * @file scripts/check-unused-files.js
 * @description
 * Backs `npm run knip:files`: the gate's check for JavaScript files
 * nothing imports, on its own. It runs knip, which starts from the entry
 * points in knip.config.js, and takes knip's command from
 * scripts/_gate-stages.js, as the gate does. It's a different check from
 * scripts/check-unused-src-modules.js, which fails when a module of a
 * feature's code is loaded only by its tests. Run it with `--help` for
 * its usage, examples and exit codes.
 */

import { knipStage } from "./_gate-stages.js";
import { requireMinNode, runInherited, scriptProgram } from "./_tools.js";

/**
 * Runs knip's check for unused files, and exits with its code.
 */
function main() {
  scriptProgram(
    "scripts/check-unused-files.js",
    "Runs knip, which lists the JavaScript files nothing imports. It " +
      "starts from the entry points in knip.config.js, every test helper " +
      "among them, and never lists one of those. The gate, npm run check, " +
      "which must pass before every commit, fails on each file it lists.",
    {
      examples: [
        "npm run knip:files",
        "    Runs the check alone, such as after moving or deleting a file,",
        "    without the rest of npm run lint, which the git pre-commit",
        "    hook runs.",
      ],
      exitCodes: [
        "0  every file is an entry point, or is imported",
        "1  at least one file isn't, and each is listed",
        "2  knip couldn't run, such as with a mistake in knip.config.js",
      ],
    },
  ).parse();
  requireMinNode("scripts/check-unused-files.js");
  const stage = knipStage();
  process.exit(runInherited(stage.command, stage.args));
}

main();
