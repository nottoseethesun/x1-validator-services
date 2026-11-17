/**
 * @file x1-validator-private-rpc/test/undo-apply-later-changes.test.js
 * @description
 * Tests undo-apply on a fake validator that others changed after apply:
 *
 * - another program's hook in place of the tool's, another file in the
 *   api keys' folder, a crontab removed, and a folder apply made already
 *   gone, all of which undo-apply leaves as they are
 * - a mask on nginx.service that was there before apply, which
 *   undo-apply puts back
 * - a hook or an api keys' file someone removed, which is no matter
 * - a crontab that refuses the new table, which keeps the cron lines on
 *   record
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  featurePaths,
  gitHookPathOf,
  hashedApiKeysPathOf,
} from "../src/cli/feature-paths.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
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

test("leaves what others changed since apply, and puts back a mask that was there before it", async () => {
  const { host, state, settings } = await appliedValidator({
    state: { masked: true },
  });
  const hookPath = gitHookPathOf(settings, HOME);
  const theirs = '#!/bin/sh\nexec git lfs post-merge "$@"\n';
  host.files.set(hookPath, theirs);
  const keysFolder = path.dirname(hashedApiKeysPathOf(settings, HOME));
  const another = path.join(keysFolder, "another-feature.json");
  host.files.set(another, "{}");
  state.crontab = null;
  const dropInFolder = path.dirname(settings.systemdDropInPath);
  host.files.delete(settings.systemdDropInPath);
  host.files.delete(dropInFolder);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(hookPath), theirs);
  assert.equal(host.files.get(another), "{}");
  assert.deepEqual([state.masked, state.nginxInstalled], [true, false]);
  for (const note of [
    `${hookPath} changed since apply wrote it, so it stays.`,
    `${keysFolder} holds files apply didn't make, so it stays.`,
  ]) {
    assert.ok(lines.includes(`[undo-apply] ${note}`), note);
  }
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
});

test("a hook or an api keys' file someone removed is no matter; a crontab that refuses the table keeps the lines on record", async () => {
  let crontabWorks = true;
  const { host, settings } = await appliedValidator({
    respond: (call) =>
      call.command === "crontab" &&
      call.args[0] === "-" &&
      crontabWorks === false
        ? { status: 1, stderr: "crontab: no changes made" }
        : undefined,
  });
  crontabWorks = false;
  host.files.delete(gitHookPathOf(settings, HOME));
  host.files.delete(hashedApiKeysPathOf(settings, HOME));
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 1);
  assert.ok(
    lines.some((line) =>
      line.includes("crontab refused the table: crontab: no changes made"),
    ),
  );
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const left = [...record.keys()].map((key) => partsOf(key).name);
  assert.deepEqual(left, ["cronLine", "cronLine"]);
});
