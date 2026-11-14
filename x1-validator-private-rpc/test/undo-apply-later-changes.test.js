/**
 * @file x1-validator-private-rpc/test/undo-apply-later-changes.test.js
 * @description
 * Tests undo-apply on a fake validator that others changed after apply:
 *
 * - another program's hook in place of the tool's, another secret in the
 *   vault, a crontab removed, and a folder apply made already gone, all
 *   of which undo-apply leaves as they are
 * - a mask on nginx.service that was there before apply, which
 *   undo-apply puts back
 * - a hook or a vault someone removed, which is no matter
 * - a crontab that refuses the new table, which keeps the cron line on
 *   record
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
import {
  API_KEY_SECRET,
  readVault,
  secretOf,
  withSecret,
  writeVault,
} from "../src/cli/vault.js";
import { partsOf, readRecord } from "../src/cli/what-apply-changed.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { HOME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs undo-apply, answering yes to its questions.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function undoApply(host, settings) {
  const prompts = scriptedPrompts({ ask: () => true });
  const run = commandRun(host, settings, { prompts, options: {} });
  const code = await runUndoApply(run);
  return { code, lines: run.lines };
}

/**
 * Finds the git hook's path where the settings put x1console.
 * @param {object} settings  The settings.
 * @returns {string}
 */
function hookPathOf(settings) {
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  return path.join(x1consoleDir, ".git", "hooks", "post-merge");
}

test("leaves what others changed since apply, and puts back a mask that was there before it", async () => {
  const { host, state, settings } = await appliedValidator({
    state: { masked: true },
  });
  const hookPath = hookPathOf(settings);
  const theirs = '#!/bin/sh\nexec git lfs post-merge "$@"\n';
  host.files.set(hookPath, theirs);
  const vaultPath = homePath(settings.vaultPath, HOME);
  const vault = readVault(host, vaultPath);
  const payload = secretOf(vault, API_KEY_SECRET);
  const others = withSecret(vault, "anotherFeature", payload);
  writeVault(host, vaultPath, others);
  state.crontab = null;
  const dropInFolder = path.dirname(settings.systemdDropInPath);
  host.files.delete(settings.systemdDropInPath);
  host.files.delete(dropInFolder);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(hookPath), theirs);
  assert.deepEqual(Object.keys(readVault(host, vaultPath).secrets), [
    "anotherFeature",
  ]);
  assert.deepEqual([state.masked, state.nginxInstalled], [true, false]);
  for (const note of [
    `${hookPath} changed since apply wrote it, so it stays.`,
    `${vaultPath} holds other secrets, so it stays.`,
  ]) {
    assert.ok(lines.includes(`[undo-apply] ${note}`), note);
  }
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
});

test("a hook or a vault someone removed is no matter; a crontab that refuses the table keeps the line on record", async () => {
  let crontabWorks = true;
  const { host, settings } = await appliedValidator({
    respond: (call) =>
      call.command === "crontab" && call.args[0] === "-" && !crontabWorks
        ? { status: 1, stderr: "crontab: no changes made" }
        : undefined,
  });
  crontabWorks = false;
  host.files.delete(hookPathOf(settings));
  host.files.delete(homePath(settings.vaultPath, HOME));
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 1);
  assert.ok(
    lines.some((line) =>
      line.includes("crontab refused the table: crontab: no changes made"),
    ),
  );
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const left = [...record.keys()].map((key) => partsOf(key).name);
  assert.deepEqual(left, ["cronLine"]);
});
