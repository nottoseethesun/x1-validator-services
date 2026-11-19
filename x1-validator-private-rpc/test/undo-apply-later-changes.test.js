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
 * - --private-rpc in the start script and the nginx account, both there
 *   before apply, which undo-apply leaves
 * - a hook or an api keys' file someone removed, which is no matter
 * - a crontab that refuses the new table, which keeps the cron lines on
 *   record
 * - a later apply that moved nginx's list, which undo-apply removes, with
 *   each folder made for it
 * - nginx removed by hand, which leaves undo-apply no service to stop,
 *   so it says how to purge what may be left
 * - another program on port 443 once undo-apply has left nginx stopped,
 *   which stops a later apply at its first check, changing nothing
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { HTTPS_RULE } from "../src/cli/apply-install.js";
import {
  featurePaths,
  gitHookPathOf,
  hashedApiKeysPathOf,
} from "../src/cli/feature-paths.js";
import { addPrivateRpc } from "../src/cli/start-script.js";
import { NGINX_GONE_ALREADY, runUndoApply } from "../src/cli/undo-apply.js";
import { partsOf, readRecord } from "../src/cli/what-apply-changed.js";
import {
  appliedValidator,
  commandRun,
  purgeNginxByHand,
} from "./helpers/applied-validator.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { fakeX1Validator, HOME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs undo-apply, answering yes to its questions, and with `purge`,
 * plays the operator's purge of the nginx it leaves, then runs it again.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {boolean} [purge]  Whether to purge nginx and run again.
 * @returns {Promise<{code: number, lines: string[]}>} The last run's exit
 *   code, and every run's lines.
 */
async function undoApply(host, settings, purge = false) {
  const prompts = scriptedPrompts({ ask: () => true });
  const run = commandRun(host, settings, { prompts, options: {} });
  let code = await runUndoApply(run);
  if (purge === true) {
    await purgeNginxByHand(host);
    const again = commandRun(host, settings, { prompts, options: {} });
    code = await runUndoApply(again);
    run.lines.push(...again.lines);
  }
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
  const { code, lines } = await undoApply(host, settings, true);
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

test("leaves --private-rpc in the start script and the nginx account, both there before apply", async () => {
  const bare = fakeX1Validator();
  const script = bare.host.files.get(bare.scriptPath);
  const withFlag = addPrivateRpc(script, bare.scriptPath).text;
  const { host, state, settings, scriptPath } = await appliedValidator({
    state: { nginxUser: true },
    files: new Map([[bare.scriptPath, withFlag]]),
  });
  // The account stays even after nginx is purged and undo-apply runs again.
  const { code, lines } = await undoApply(host, settings, true);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(scriptPath), withFlag);
  assert.equal(state.nginxUser, true);
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
  // Purged first, so nothing of nginx's stays on record.
  await purgeNginxByHand(host);
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

test("after a later apply moves nginx's list, undo-apply removes the new list and each folder made for it", async () => {
  const { host, settings } = await appliedValidator();
  const { changed } = shippedAndChangedSettings();
  settings.hashedApiKeysMapPath = changed.hashedApiKeysMapPath;
  const applying = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(applying), 0, applying.lines.join("\n"));
  const mapPath = settings.hashedApiKeysMapPath;
  const top = path.dirname(path.dirname(mapPath));
  assert.equal(host.exists(mapPath), true);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(
    [mapPath, top].map((filePath) => host.exists(filePath)),
    [false, false],
  );
});

test("after nginx is removed by hand, undo-apply has no service to stop, says how to purge what may be left, and still finishes", async () => {
  // After apt remove, dpkg still lists each package, with its config files.
  let removed = false;
  const { host, state, settings } = await appliedValidator({
    respond: (call) =>
      removed === true && call.command === "dpkg-query"
        ? { stdout: "deinstall ok config-files 1.30.6-1~noble" }
        : undefined,
  });
  removed = true;
  Object.assign(state, {
    nginxInstalled: false,
    enabled: false,
    active: false,
  });
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  for (const note of [
    "nginx isn't installed, so there's nothing to stop, disable or mask.",
    NGINX_GONE_ALREADY,
  ]) {
    assert.ok(lines.includes(`[undo-apply] ${note}`), note);
  }
  assert.equal(host.exists(featurePaths().whatApplyChangedPath), false);
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
});

test("once undo-apply has left nginx stopped, another program on port 443 stops a later apply at its first check, changing nothing", async () => {
  let otherOn443 = false;
  const { host, state, settings } = await appliedValidator({
    respond: (call) =>
      otherOn443 === true &&
      call.command === "ss" &&
      call.args.join(" ") === "-ltnH sport = :443"
        ? { stdout: "LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n" }
        : undefined,
  });
  const undone = await undoApply(host, settings);
  assert.equal(undone.code, 0, undone.lines.join("\n"));
  otherOn443 = true;
  const recordPath = featurePaths().whatApplyChangedPath;
  const record = host.files.get(recordPath);
  const applying = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  await assert.rejects(
    runApply(applying),
    /Something already listens on port 443/,
  );
  assert.deepEqual(
    [state.ufwRules.includes(HTTPS_RULE), state.masked],
    [false, true],
  );
  assert.equal(host.files.get(recordPath), record);
});
