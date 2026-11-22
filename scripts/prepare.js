#!/usr/bin/env node
/**
 * @file scripts/prepare.js
 * @description
 * `npm run prepare`, which `npm install` and `npm ci` run on their own,
 * after they install the packages. It sets up the `git` pre-commit hook,
 * which runs `npm run lint` before each commit, by running `husky`, the
 * package that installs `git` hooks, in the project's root. `husky` takes
 * its first argument as the folder for the hooks, so this script answers
 * `--help` itself, and passes `husky` no argument. On a validator, `npm
 * ci --ignore-scripts` skips it, since the hook is a development tool.
 */

import {
  requireMinNode,
  runInherited,
  scriptProgram,
  toolPath,
} from "./_tools.js";

/**
 * Sets up the pre-commit hook, and exits with husky's exit code.
 */
function main() {
  scriptProgram(
    "scripts/prepare.js",
    "Sets up the git pre-commit hook with husky, the package that installs " +
      "git hooks. The hook runs npm run lint before each commit. npm install " +
      "and npm ci run this script on their own, after they install the " +
      "packages, so you run it by hand only to set the hook up again.",
    {
      examples: [
        "npm run prepare",
        "    Sets the hook up again, such as after a change to git's",
        "    core.hooksPath setting, which tells git where the hooks are.",
      ],
      exitCodes: [
        "0  husky ran. It prints the reason when it couldn't set the hook",
        "   up, such as in a folder that isn't a git repository",
        "1  husky couldn't run, such as when the development tools aren't",
        "   installed",
      ],
    },
  ).parse();
  requireMinNode("scripts/prepare.js");
  process.exit(runInherited(toolPath("husky"), []));
}

main();
