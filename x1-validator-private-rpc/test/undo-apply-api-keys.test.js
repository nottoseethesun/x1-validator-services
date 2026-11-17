/**
 * @file x1-validator-private-rpc/test/undo-apply-api-keys.test.js
 * @description
 * Tests undo-apply's one question about the api keys, on a fake
 * validator that apply set up:
 *
 * - a no keeps every key and the saved password, with their folders,
 *   while nginx's list goes with nginx's other files, and a later apply
 *   hands the same keys to nginx, with no new key and no question about
 *   the password
 * - with no password saved, the question names the api keys alone
 * - a refused sudo at the yes changes nothing, so the api keys' file and
 *   nginx's list still agree
 * - a saved password that couldn't be deleted stays recorded, and a
 *   later run takes it
 * - kept keys may go even when the record holds nothing else
 * - it holds the api keys' lock from its question to its end, and stops
 *   before asking while another command holds it
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { featurePaths, hashedApiKeysPathOf } from "../src/cli/feature-paths.js";
import { KEYS_LOCKED } from "../src/cli/hashed-api-keys.js";
import { readState } from "../src/cli/state.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
import { partsOf, readRecord } from "../src/cli/what-apply-changed.js";
import { hashApiKey } from "../src/lib/key-hash-map.js";
import { loadSettings } from "../src/lib/settings.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs undo-apply.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {boolean} [yes]  The answer to its question.
 * @returns {Promise<{code: number, lines: string[], asked: string[]}>}
 */
async function undoApply(host, settings, yes = true) {
  const prompts = scriptedPrompts({ ask: () => yes });
  const run = commandRun(host, settings, { prompts, options: {} });
  const code = await runUndoApply(run);
  return { code, lines: run.lines, asked: prompts.asked };
}

/**
 * Lists the names of the recorded settings, oldest first.
 * @param {object} host  The fake host.
 * @returns {string[]}
 */
function recordedNames(host) {
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  return [...record.keys()].map((key) => partsOf(key).name);
}

test("keeps the api keys and the saved password when told no, with their folders, and a later apply hands the same keys to nginx", async () => {
  const { host, state, settings, apiKey } = await appliedValidator(
    {},
    { savePassword: true },
  );
  const paths = featurePaths();
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const keysText = host.files.get(keysFile);
  const credentialFolder = path.dirname(settings.passwordCredentialPath);
  const { code, lines, asked } = await undoApply(host, settings, false);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(asked.length, 1);
  assert.equal(host.files.get(keysFile), keysText);
  assert.ok(host.files.has(settings.passwordCredentialPath));
  // nginx's list goes with nginx's other files.
  assert.equal(host.files.has(settings.hashedApiKeysMapPath), false);
  for (const [stays, folder] of [
    [keysFile, path.dirname(keysFile)],
    [settings.passwordCredentialPath, credentialFolder],
  ]) {
    assert.ok(
      lines.includes(
        `[undo-apply] Kept, since ${stays} stays: the change behind "remove the folder ${folder}".`,
      ),
      lines.join("\n"),
    );
  }
  assert.deepEqual(recordedNames(host), [
    "hashedApiKeysFolder",
    "hashedApiKeysFolder",
    "savedPasswordFolder",
    "savedPassword",
  ]);
  assert.equal(readState(host, paths.statePath).setup, null);
  // A later apply makes no key, asks nothing secret, and nginx takes it.
  const prompts = scriptedPrompts();
  const again = commandRun(host, settings, {
    prompts,
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  assert.deepEqual(again.printed, []);
  const secret = (question) =>
    question.endsWith("password: ") || question.startsWith("Save the password");
  assert.deepEqual(prompts.asked.filter(secret), []);
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  const later = await undoApply(host, settings);
  assert.equal(later.code, 0, later.lines.join("\n"));
  for (const filePath of [
    keysFile,
    path.dirname(keysFile),
    settings.passwordCredentialPath,
    credentialFolder,
    path.dirname(paths.whatApplyChangedPath),
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("with no password saved, it asks about the api keys alone", async () => {
  const { host, settings } = await appliedValidator();
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const { code, lines, asked } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith("Delete every api key? "), asked[0]);
  assert.equal(host.files.has(keysFile), false);
});

test("a refused sudo at the yes changes nothing, so the api keys' file and nginx's list still agree", async () => {
  let refuse = true;
  const { host, state, settings, apiKey } = await appliedValidator({
    respond: (call) =>
      refuse === true && call.kind === "sudo" && call.command === "true"
        ? { status: 1, stderr: "sudo: 3 incorrect password attempts" }
        : undefined,
  });
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const recordPath = featurePaths().whatApplyChangedPath;
  const before = readRecord(host, recordPath);
  const prompts = scriptedPrompts({ ask: () => true });
  const refused = commandRun(host, settings, { prompts, options: {} });
  await assert.rejects(runUndoApply(refused), {
    message:
      "Getting sudo before changing anything failed with exit code 1: " +
      "sudo: 3 incorrect password attempts",
  });
  assert.ok(host.files.has(keysFile));
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  assert.deepEqual(readRecord(host, recordPath), before);
  assert.equal(host.locks.size, 0);
  refuse = false;
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.has(keysFile), false);
});

test("a saved password that couldn't be deleted stays recorded, and a later run takes it", async () => {
  const { host, settings } = await appliedValidator({}, { savePassword: true });
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const removeRootFile = host.removeRootFile;
  let removalWorks = false;
  host.removeRootFile = (filePath) => {
    if (
      filePath === settings.passwordCredentialPath &&
      removalWorks === false
    ) {
      throw new Error("Operation not permitted");
    }
    return removeRootFile(filePath);
  };
  const { code } = await undoApply(host, settings);
  assert.equal(code, 1);
  assert.ok(host.files.has(settings.passwordCredentialPath));
  assert.equal(host.files.has(keysFile), false);
  assert.deepEqual(recordedNames(host), [
    "savedPasswordFolder",
    "savedPassword",
  ]);
  removalWorks = true;
  const later = await undoApply(host, settings);
  assert.equal(later.code, 0, later.lines.join("\n"));
  assert.equal(host.files.has(settings.passwordCredentialPath), false);
});

test("kept api keys may go even when the record holds nothing else", async () => {
  const settings = loadSettings(copyShippedConfig().configDir);
  const { host } = fakeX1Validator({ settings });
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  host.writeUserFile(keysFile, "{}", 0o600);
  const { code, lines, asked } = await undoApply(host, settings);
  assert.equal(code, 0);
  assert.equal(asked.length, 1);
  assert.deepEqual(lines, [
    `[undo-apply] Done: deleted every api key, with ${keysFile}.`,
    "[undo-apply] apply hasn't changed anything else here.",
  ]);
  assert.equal(host.files.has(keysFile), false);
});

test("holds the api keys' lock from its question to its end, and stops before asking while another command holds it", async () => {
  const { host, settings } = await appliedValidator();
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const folder = path.dirname(keysFile);
  const release = host.lockFolder(folder);
  const prompts = scriptedPrompts({ ask: () => true });
  const blocked = commandRun(host, settings, { prompts, options: {} });
  await assert.rejects(runUndoApply(blocked), { message: KEYS_LOCKED });
  assert.deepEqual(prompts.asked, []);
  assert.ok(host.files.has(keysFile));
  release();
  const from = host.calls.length;
  const { code, lines } = await undoApply(host, settings, true);
  assert.equal(code, 0, lines.join("\n"));
  const calls = host.calls.slice(from);
  assert.deepEqual(calls.at(0), { kind: "lockFolder", path: folder });
  assert.deepEqual(calls.at(-1), { kind: "unlockFolder", path: folder });
  assert.equal(host.locks.size, 0);
});
