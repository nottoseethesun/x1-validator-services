/**
 * @file test/script-help.test.js
 * @description
 * Tests that every script the project runs by its path answers `--help`
 * and `-h` with its help on stdout and exit code 0, and refuses an
 * argument it doesn't take with exit code 1. Each help must give usage
 * examples, then the exit codes. Its examples must use each option it
 * lists, but `--help`, and no option it doesn't list. An example that
 * runs an `npm run` target counts as the command the target runs, from
 * package.json, so `npm run lint:fix` uses lint.js's `--fix`. Helper
 * modules, whose names start with an underscore, and the shared file
 * lists are left out: they are never run by their path. It also tests
 * that each script stops on a Node.js older than the one `engines` in
 * package.json names, and that every `npm run` target runs one of the
 * scripts, so each target's help is the project's own.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listFilesUnder, projectRoot } from "../scripts/_tools.js";
import { optionGaps } from "./helpers/help-options.js";

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
 * Reads the `npm run` targets from package.json.
 * @returns {Record<string, string>} Each target's command, by the
 *   target's name.
 */
function npmTargets() {
  const packageJson = readFileSync(
    path.join(projectRoot(), "package.json"),
    "utf8",
  );
  return JSON.parse(packageJson).scripts;
}

/**
 * Gives the command an example's line runs. A line that runs an `npm
 * run` target, or `npm test`, runs the target's command in package.json,
 * with any arguments the line passes after `--`. Any other line runs as
 * it's written.
 * @param {Record<string, string>} targets  The `npm run` targets'
 *   commands, by name.
 * @param {string} line  The example's line, such as `npm run lint:fix`.
 * @returns {string} The command, such as `node scripts/lint.js --fix`.
 */
function commandRun(targets, line) {
  const match = /^npm (?:run (\S+)|test)(?: -- (.+))?$/.exec(line);
  if (match === undefined || match === null) {
    return line;
  }
  const target = match[1] ?? "test";
  const command = targets[target];
  assert.ok(
    command !== undefined && command !== null,
    `${line}: package.json has no target ${target}`,
  );
  const passed = match[2];
  return passed === undefined || passed === null
    ? command
    : `${command} ${passed}`;
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

test("every script stops on a Node.js older than the one engines names", () => {
  for (const script of runnableScripts()) {
    const text = readFileSync(path.join(projectRoot(), script), "utf8");
    assert.ok(text.includes(`requireMinNode("${script}")`), script);
  }
});

test("every npm run target runs one of the scripts, whose help the tests below check", () => {
  const scripts = runnableScripts();
  for (const [target, command] of Object.entries(npmTargets())) {
    const match = /^node (scripts\/[\w-]+\.js)(?: |$)/.exec(command);
    assert.ok(
      match !== undefined && match !== null && scripts.includes(match[1]),
      `${target}: ${command}`,
    );
  }
});

for (const script of runnableScripts()) {
  test(`${script} answers --help and -h with its help, whose examples use each option it lists, but help, and no other`, () => {
    const targets = npmTargets();
    for (const flag of ["--help", "-h"]) {
      const result = runScript(script, [flag]);
      assert.equal(result.status, 0, `${flag} exit code`);
      assert.match(result.stdout, /^Usage: node scripts\//);
      assert.match(
        result.stdout,
        /\nExamples:\n {2}\S[^]*\n\nExit codes:\n {2}\S/,
      );
      assert.deepEqual(
        optionGaps(result.stdout, {
          runs: (line) => commandRun(targets, line),
        }),
        [],
        flag,
      );
    }
  });

  test(`${script} refuses an argument it doesn't take`, () => {
    const result = runScript(script, ["--no-such-option"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown option '--no-such-option'/);
  });
}
