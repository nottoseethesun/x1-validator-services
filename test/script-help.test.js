/**
 * @file test/script-help.test.js
 * @description
 * Tests that every script the project runs by its path answers `--help`
 * and `-h` with its usage on stdout and exit code 0, and refuses an
 * argument it doesn't take with exit code 1. Helper modules, whose names
 * start with an underscore, and the shared file lists are left out: they
 * are never run by their path.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { listFilesUnder, projectRoot } from "../scripts/_tools.js";

/**
 * Lists the scripts run by their path.
 * @returns {string[]} Their paths, relative to the project's root.
 */
function runnableScripts() {
  return listFilesUnder(projectRoot(), "scripts").filter((file) => {
    const name = path.basename(file);
    return (
      name.endsWith(".js") &&
      !name.startsWith("_") &&
      name !== "lint-targets.js"
    );
  });
}

/**
 * Runs a script with the given arguments, and waits for it.
 * @param {string} script  The script's path, relative to the root.
 * @param {string[]} args  The arguments.
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot(),
    encoding: "utf8",
  });
}

test("there are scripts to check", () => {
  assert.ok(runnableScripts().includes("scripts/check.js"));
});

for (const script of runnableScripts()) {
  test(`${script} answers --help and -h with its usage`, () => {
    for (const flag of ["--help", "-h"]) {
      const result = runScript(script, [flag]);
      assert.equal(result.status, 0, `${flag} exit code`);
      assert.match(result.stdout, /^Usage: node scripts\//);
    }
  });

  test(`${script} refuses an argument it doesn't take`, () => {
    const result = runScript(script, ["--no-such-option"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument: --no-such-option/);
  });
}
