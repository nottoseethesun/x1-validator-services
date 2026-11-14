/**
 * @file x1-validator-private-rpc/test/apply-new-key.test.js
 * @description
 * Tests apply after the vault was deleted by hand, on a fake validator
 * that apply set up. apply makes a new key and hands it to nginx, though
 * no file of nginx's changed. A password saved for the old key can't
 * open the new one, so a yes to saving writes the new password over it,
 * and a no removes it.
 *
 * Whenever the fourth stage saves the password or removes it, it brings
 * nginx's drop-in in line at once, and has systemd read it again: after
 * the file is written, or before it's deleted. So a stop at the fifth
 * stage leaves systemd expecting no file that's gone, and unlock can
 * restart nginx. A run that ends before nginx has the new key says, at
 * exit, to run unlock. A fresh validator's run doesn't, since its nginx
 * has no key yet. A run that ends at the save question leaves the old
 * saved password marked stale in the tool's state, so the next run asks
 * the question again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY_NOT_WITH_NGINX, runApply } from "../src/cli/apply.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { runUnlock } from "../src/cli/key-commands.js";
import { readState } from "../src/cli/state.js";
import { API_KEY_SECRET, decryptSecret, secretOf } from "../src/cli/vault.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
} from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const NEW_PASSWORD = "another long test password";

/**
 * Makes apply's answers.
 * @param {boolean} save  The answer to the save question.
 * @param {boolean} stopAtStage5  Whether to answer no at the fifth stage.
 * @param {string} password  The password typed, twice for a new one.
 * @returns {object} The prompts.
 */
function answers(save, stopAtStage5, password) {
  return scriptedPrompts({
    confirm: (question) =>
      !(stopAtStage5 === true && question.startsWith("Stage 5 of 8")),
    ask: () => save,
    passwords: [password, password],
  });
}

/**
 * Runs apply, then the callbacks it leaves for the process's exit.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} prompts  The answers.
 * @returns {Promise<{code: number, lines: string[], atExit: string[]}>}
 *   The exit code, what apply printed, and what it printed at exit.
 */
async function applyThenExit(host, settings, prompts) {
  const callbacks = [];
  const run = commandRun(host, settings, {
    prompts,
    options: { yes: false, dryRun: false, acmeStaging: false },
    atExit: (callback) => callbacks.push(callback),
  });
  const code = await runApply(run);
  const lines = [...run.lines];
  for (const callback of callbacks) {
    callback();
  }
  return { code, lines, atExit: run.lines.slice(lines.length) };
}

/**
 * Sets up a validator, deletes the vault, and runs apply again, which
 * makes a key under a new password.
 * @param {object} how  How the runs go.
 * @param {boolean} how.savedBefore  Whether the first apply saved the
 *   password.
 * @param {boolean} how.save  The second apply's answer to the save
 *   question.
 * @param {boolean} [how.stopAtStage5]  Whether the second apply stops at
 *   the fifth stage.
 * @returns {Promise<object>} The fake, its state, the settings, the exit
 *   code, what apply printed and printed at exit, the calls it made, and
 *   the new key in the vault.
 */
async function applyAfterVaultLoss({ savedBefore, save, stopAtStage5 }) {
  const { host, state, settings } = await appliedValidator(
    {},
    { savePassword: savedBefore },
  );
  const vaultPath = homePath(settings.vaultPath, host.homeDir());
  host.files.delete(vaultPath);
  const callsBefore = host.calls.length;
  const prompts = answers(save, stopAtStage5 === true, NEW_PASSWORD);
  const { code, lines, atExit } = await applyThenExit(host, settings, prompts);
  const calls = host.calls.slice(callsBefore);
  const vault = JSON.parse(host.files.get(vaultPath));
  const payload = secretOf(vault, API_KEY_SECRET);
  const key = await decryptSecret(payload, NEW_PASSWORD);
  return { host, state, settings, code, lines, atExit, calls, key };
}

/**
 * Finds where the first call that matches comes among the calls.
 * @param {object[]} calls  The fake's calls.
 * @param {(call: object) => boolean} matches  Picks the call.
 * @returns {number} Its place, or -1.
 */
function placeOf(calls, matches) {
  return calls.findIndex(matches);
}

test("apply hands nginx the new key, though no file of nginx's changed, and saves the new password over the old one", async () => {
  const { host, state, code, lines, atExit, key } = await applyAfterVaultLoss({
    savedBefore: true,
    save: true,
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(state.key, key);
  assert.ok(
    lines.includes(
      "[key] The saved password is for the old key, and can't open this new one.",
    ),
  );
  const encrypt = host.calls
    .filter((call) => call.command === "systemd-creds")
    .at(-1);
  assert.equal(encrypt.input, NEW_PASSWORD);
  assert.deepEqual(atExit, []);
  // Marked stale while the question was open, then cleared on disk.
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("a no to saving removes the old saved password, and nginx still gets the new key", async () => {
  const { host, state, settings, code, key } = await applyAfterVaultLoss({
    savedBefore: true,
    save: false,
  });
  assert.equal(code, 0);
  assert.equal(host.files.has(settings.passwordCredentialPath), false);
  assert.doesNotMatch(
    host.files.get(settings.systemdDropInPath),
    /^LoadCredentialEncrypted=/m,
  );
  assert.equal(state.key, key);
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("a no to saving, then a stop at the fifth stage: systemd stops loading the old password before it goes, and unlock gives nginx the new key", async () => {
  const { host, state, settings, code, lines, atExit, calls, key } =
    await applyAfterVaultLoss({
      savedBefore: true,
      save: false,
      stopAtStage5: true,
    });
  assert.equal(code, 1, lines.join("\n"));
  assert.doesNotMatch(
    host.files.get(settings.systemdDropInPath),
    /^LoadCredentialEncrypted=/m,
  );
  assert.equal(host.files.has(settings.passwordCredentialPath), false);
  const rewritten = placeOf(
    calls,
    (call) =>
      call.kind === "writeRootFile" && call.path === settings.systemdDropInPath,
  );
  const reloaded = placeOf(
    calls,
    (call) => call.command === "systemctl" && call.args[0] === "daemon-reload",
  );
  const removed = placeOf(
    calls,
    (call) =>
      call.kind === "removeRootFile" &&
      call.path === settings.passwordCredentialPath,
  );
  assert.ok(
    rewritten >= 0 && rewritten < reloaded && reloaded < removed,
    JSON.stringify({ rewritten, reloaded, removed }),
  );
  assert.deepEqual(atExit, [`[apply] ${KEY_NOT_WITH_NGINX}`]);
  const unlock = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [NEW_PASSWORD] }),
  });
  assert.equal(await runUnlock(unlock), 0, unlock.lines.join("\n"));
  assert.equal(state.key, key);
});

test("a password saved for the first time goes into the drop-in once its file is there, and a stop at the fifth stage says to run unlock", async () => {
  const { host, settings, code, atExit, calls } = await applyAfterVaultLoss({
    savedBefore: false,
    save: true,
    stopAtStage5: true,
  });
  assert.equal(code, 1);
  assert.match(
    host.files.get(settings.systemdDropInPath),
    /^LoadCredentialEncrypted=/m,
  );
  const saved = placeOf(
    calls,
    (call) => call.command === "systemd-creds" && call.args[0] === "encrypt",
  );
  const rewritten = placeOf(
    calls,
    (call) =>
      call.kind === "writeRootFile" && call.path === settings.systemdDropInPath,
  );
  const reloaded = placeOf(
    calls,
    (call) => call.command === "systemctl" && call.args[0] === "daemon-reload",
  );
  assert.ok(
    saved >= 0 && saved < rewritten && rewritten < reloaded,
    JSON.stringify({ saved, rewritten, reloaded }),
  );
  assert.deepEqual(atExit, [`[apply] ${KEY_NOT_WITH_NGINX}`]);
});

test("a run that ends at the save question leaves the old saved password marked stale, so the next run asks again", async () => {
  const { host, settings } = await appliedValidator({}, { savePassword: true });
  host.files.delete(homePath(settings.vaultPath, host.homeDir()));
  const options = { yes: false, dryRun: false, acmeStaging: false };
  const interrupted = commandRun(host, settings, {
    prompts: scriptedPrompts({
      ask: () => {
        throw new Error("Ctrl-C at the save question");
      },
      passwords: [NEW_PASSWORD, NEW_PASSWORD],
    }),
    options,
  });
  await assert.rejects(runApply(interrupted), {
    message: "Ctrl-C at the save question",
  });
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, true);
  const prompts = scriptedPrompts({
    ask: () => true,
    passwords: [NEW_PASSWORD],
  });
  const again = commandRun(host, settings, { prompts, options });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  assert.equal(
    again.lines.includes("[key] The password is saved already."),
    false,
  );
  assert.ok(
    prompts.asked.includes(
      "Save the password, so nginx unlocks itself after a restart?",
    ),
  );
  const encrypt = host.calls
    .filter((call) => call.command === "systemd-creds")
    .at(-1);
  assert.equal(encrypt.input, NEW_PASSWORD);
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("a fresh validator's apply, stopped at the fifth stage, says nothing at exit, since its nginx has no key yet", async () => {
  const settings = loadSettings(
    copyShippedConfig(JSON.stringify({ hostname: HOSTNAME })).configDir,
  );
  const { host } = fakeX1Validator({ settings });
  const prompts = answers(false, true, PASSWORD);
  const { code, atExit } = await applyThenExit(host, settings, prompts);
  assert.equal(code, 1);
  assert.deepEqual(atExit, []);
});
