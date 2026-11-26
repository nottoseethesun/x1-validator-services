/**
 * @file x1-validator-private-rpc/test/apply-new-key.test.js
 * @description
 * Tests apply's fourth stage, the api keys and the password, on a fake
 * validator that apply set up:
 *
 * - after the file of api keys was deleted by hand, apply makes a new
 *   first key under a new password, and shows it. A password saved for
 *   the old file can't open the new one, so a yes to saving writes the
 *   new password over it, and a no removes it.
 * - a run that ends at the save question leaves the old saved password
 *   marked stale in the tool's state, so the next run, which finds the
 *   new key there, asks for the password, as many times as the settings
 *   say, and the question again
 * - nginx's list, out of step with the file, is written again and nginx
 *   reloads, and a list in step is left alone
 * - a dry run says what it would hand nginx, and changes nothing
 * - a file with no record, on a fresh validator, gets a first key under
 *   the file's own password, typed within as many tries as the settings
 *   say
 * - a new first key is shown before nginx's list is written, so a failed
 *   write of the list loses no key unseen
 * - a new key nginx refuses for a moment, while its reload takes the new
 *   list, is asked about again until nginx takes it
 * - the stage holds the api keys' lock while it asks, and stops with no
 *   key made while another command holds it
 * - the key it hands on is checked before the fifth stage uses it
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { configureNginx } from "../src/cli/apply-nginx.js";
import {
  checkedKey,
  NEW_PASSWORD_PROMPT,
  PASSWORD_PROMPT,
  SAVE_PASSWORD_QUESTION,
} from "../src/cli/apply-key.js";
import { featurePaths, hashedApiKeysPathOf } from "../src/cli/feature-paths.js";
import {
  KEYS_LOCKED,
  newHashedApiKeys,
  readHashedApiKeys,
  WRONG_PASSWORD,
  writeHashedApiKeys,
} from "../src/cli/hashed-api-keys.js";
import { API_KEY_PATTERN, makeApiKey } from "../src/lib/api-key.js";
import { readState } from "../src/cli/state.js";
import { hashApiKey } from "../src/lib/key-hash-map.js";
import { NGINX_UNIT } from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
  printedKeys,
} from "./helpers/applied-validator.js";
import {
  copyShippedConfig,
  shippedAndChangedSettings,
} from "./helpers/config-copies.js";
import {
  fakeX1Validator,
  HOME,
  HOSTNAME,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const NEW_PASSWORD = "another long test password";

const OPTIONS = { yes: false, dryRun: false, acmeStaging: false };

/**
 * Sets up a validator with a saved password, deletes the file of api
 * keys, and runs apply again, which makes a key under a new password.
 * @param {boolean} save  The second apply's answer to the save question.
 * @returns {Promise<object>} The fake, its state, the settings, the run
 *   and the new key.
 */
async function applyAfterFileLoss(save) {
  const { host, state, settings } = await appliedValidator(
    {},
    { savePassword: true },
  );
  host.files.delete(hashedApiKeysPathOf(settings, HOME));
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({
      ask: () => save,
      passwords: [NEW_PASSWORD, NEW_PASSWORD],
    }),
    options: OPTIONS,
  });
  run.code = await runApply(run);
  const [key] = printedKeys(run.printed);
  return { host, state, settings, run, key };
}

test("after the file was lost, apply makes a new first key, nginx takes it, and a yes saves the new password over the old one", async () => {
  const { host, state, run, key } = await applyAfterFileLoss(true);
  assert.equal(run.code, 0, run.lines.join("\n"));
  assert.deepEqual(state.loadedHashes, [hashApiKey(key)]);
  assert.ok(
    run.lines.includes(
      "[keys] The saved password is for an earlier file of api keys, and " +
        "can't open this one.",
    ),
    run.lines.join("\n"),
  );
  const encrypt = host.calls
    .filter((call) => call.command === "systemd-creds")
    .at(-1);
  assert.equal(encrypt.input, NEW_PASSWORD);
  // Marked stale while the question was open, then cleared on disk.
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("after the file was lost, a no to saving removes the old saved password", async () => {
  const { host, state, settings, run, key } = await applyAfterFileLoss(false);
  assert.equal(run.code, 0, run.lines.join("\n"));
  assert.equal(host.files.has(settings.passwordCredentialPath), false);
  assert.deepEqual(state.loadedHashes, [hashApiKey(key)]);
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("a run that ends at the save question leaves the old saved password marked stale, so the next run asks again", async () => {
  const { host, settings } = await appliedValidator({}, { savePassword: true });
  host.files.delete(hashedApiKeysPathOf(settings, HOME));
  const interrupted = commandRun(host, settings, {
    prompts: scriptedPrompts({
      ask: () => {
        throw new Error("Ctrl-C at the save question");
      },
      passwords: [NEW_PASSWORD, NEW_PASSWORD],
    }),
    options: OPTIONS,
  });
  await assert.rejects(runApply(interrupted), {
    message: "Ctrl-C at the save question",
  });
  // The key was shown before the question, so the operator has it.
  assert.equal(printedKeys(interrupted.printed).length, 1);
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath).savedPasswordStale, true);
  // A changed number of tries, with the right password last.
  const tries = shippedAndChangedSettings().changed.passwordTries;
  const wrong = Array.from({ length: tries - 1 }, (_, n) => `wrong ${n}`);
  const prompts = scriptedPrompts({
    ask: () => true,
    passwords: [...wrong, NEW_PASSWORD],
  });
  const later = { ...settings, passwordTries: tries };
  const again = commandRun(host, later, { prompts, options: OPTIONS });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  assert.deepEqual(again.printed, []);
  assert.ok(prompts.asked.includes(PASSWORD_PROMPT));
  assert.ok(prompts.asked.includes(SAVE_PASSWORD_QUESTION));
  const encrypt = host.calls
    .filter((call) => call.command === "systemd-creds")
    .at(-1);
  assert.equal(encrypt.input, NEW_PASSWORD);
  assert.equal(readState(host, statePath).savedPasswordStale, false);
});

test("nginx's list, out of step with the file, is written again and nginx reloads; a list in step is left alone", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  host.files.set(settings.hashedApiKeysMapPath, "");
  state.loadedHashes = [];
  const before = host.calls.length;
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: OPTIONS,
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  const calls = host.calls.slice(before);
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "writeRootFile" &&
        call.path === settings.hashedApiKeysMapPath,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.command === "systemctl" &&
        call.args.join(" ") === `reload ${NGINX_UNIT}`,
    ),
  );
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  const steady = host.calls.length;
  const again = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: OPTIONS,
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  assert.equal(
    host.calls
      .slice(steady)
      .some((call) => call.path === settings.hashedApiKeysMapPath),
    false,
  );
});

test("a dry run says what it would hand nginx, and changes nothing", async () => {
  const { host, settings } = await appliedValidator();
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const before = host.calls.length;
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: { ...OPTIONS, dryRun: true },
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  assert.ok(
    run.lines.includes(
      `[keys] Would hand nginx the hashes of the 1 api key in ${filePath}, if nginx's list differs from them.`,
    ),
  );
  const writes = ["writeRootFile", "writeUserFile", "makeUserDir"];
  assert.equal(
    host.calls.slice(before).some((call) => writes.includes(call.kind)),
    false,
  );
});

test("a file of api keys with no record gets a first key, under the file's own password, typed within as many tries as the settings say", async () => {
  // A changed number of tries, so code that kept the shipped one would show.
  const tries = shippedAndChangedSettings().changed.passwordTries;
  const override = JSON.stringify({ hostname: HOSTNAME, passwordTries: tries });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host } = fakeX1Validator({ settings });
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const { keys } = await newHashedApiKeys(PASSWORD, 1);
  writeHashedApiKeys(host, filePath, keys);
  const wrong = Array.from({ length: tries - 1 }, (_, n) => `wrong ${n}`);
  const stubborn = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [...wrong, "wrong too"] }),
    options: OPTIONS,
  });
  await assert.rejects(runApply(stubborn), (error) =>
    error.message.includes(WRONG_PASSWORD),
  );
  const prompts = scriptedPrompts({ passwords: [...wrong, PASSWORD] });
  const run = commandRun(host, settings, { prompts, options: OPTIONS });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  assert.ok(prompts.asked.includes(PASSWORD_PROMPT));
  assert.equal(prompts.asked.includes(NEW_PASSWORD_PROMPT), false);
  const [key] = printedKeys(run.printed);
  const written = readHashedApiKeys(host, filePath);
  assert.deepEqual([...written.records.keys()], [hashApiKey(key)]);
  assert.equal(written.kdfParams.saltHex, keys.kdfParams.saltHex);
});

test("a new first key is shown before nginx's list is written, so a failed write of the list loses no key unseen", async () => {
  const { host, settings } = await appliedValidator();
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  host.files.delete(keysFile);
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, ...rest) => {
    if (filePath === settings.hashedApiKeysMapPath) {
      throw new Error("No space left on device");
    }
    return writeRootFile(filePath, ...rest);
  };
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [NEW_PASSWORD, NEW_PASSWORD] }),
    options: OPTIONS,
  });
  await assert.rejects(runApply(run), (error) =>
    error.message.includes("No space left on device"),
  );
  const made = printedKeys(run.printed);
  assert.equal(made.length, 1, run.lines.join("\n"));
  const keys = readHashedApiKeys(host, keysFile);
  assert.ok(keys.records.has(hashApiKey(made[0])));
});

test("a new key nginx refuses for a moment, while its reload takes the new list, is asked about again until nginx takes it", async () => {
  const { host, settings } = await appliedValidator();
  host.files.delete(hashedApiKeysPathOf(settings, HOME));
  const tlsGet = host.tlsGet;
  let keyedAsks = 0;
  const keyedHealth = new RegExp(`^/${API_KEY_PATTERN}/health$`);
  host.tlsGet = async (target) => {
    if (!keyedHealth.test(target.path)) {
      return tlsGet(target);
    }
    keyedAsks += 1;
    // The first two rounds land on workers that still hold the old list.
    return keyedAsks <= 4
      ? { status: 403, body: "", certificate: {} }
      : tlsGet(target);
  };
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
    options: OPTIONS,
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  // Each round asks with the new key and with a random one.
  assert.ok(keyedAsks > 4, String(keyedAsks));
  assert.ok(
    run.lines.includes(
      "[nginx] Test requests from this machine through nginx: the new api key got through, and requests without a key or with a random one got 403.",
    ),
  );
});

test("apply's fourth stage holds the api keys' lock while it asks for the password, and stops with no key made while another command holds it", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host } = fakeX1Validator({ settings });
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const folder = path.dirname(filePath);
  host.makeUserDir(folder, 0o700);
  const release = host.lockFolder(folder);
  const passwords = [NEW_PASSWORD, NEW_PASSWORD];
  const blocked = scriptedPrompts({ ask: () => true, passwords });
  const stopped = commandRun(host, settings, {
    prompts: blocked,
    options: OPTIONS,
  });
  await assert.rejects(runApply(stopped), { message: KEYS_LOCKED });
  assert.equal(host.exists(filePath), false);
  assert.equal(blocked.asked.includes(NEW_PASSWORD_PROMPT), false);
  release();
  const heldAtPrompt = [];
  const prompts = scriptedPrompts({ ask: () => true, passwords });
  const typed = prompts.password;
  prompts.password = async (prompt) => {
    heldAtPrompt.push(host.locks.has(folder));
    return typed(prompt);
  };
  const run = commandRun(host, settings, { prompts, options: OPTIONS });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  assert.deepEqual(heldAtPrompt, [true, true]);
  assert.equal(host.locks.size, 0);
});

test('the key the fourth stage hands on is checked before the fifth uses it: never undefined, always a string, and either "" or an api key', async () => {
  const key = makeApiKey();
  assert.equal(checkedKey(key), key);
  assert.equal(checkedKey(""), "");
  const refusalOf = (bad) => {
    try {
      checkedKey(bad);
      return { name: "", message: "" };
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  };
  const bad = [undefined, null, `${key}0`, 7, key.toUpperCase()];
  const refusals = bad.map((value) => refusalOf(value));
  /*-
   * Each is the check's own refusal, never a TypeError from a value it
   * let through.
   */
  assert.deepEqual(
    refusals.map((refusal) => refusal.name),
    bad.map(() => "Error"),
  );
  /*-
   * undefined, a non-string and a text that isn't a key each meet a check
   * of their own, so none hides behind another.
   */
  const first = refusals.slice(0, 3).map((refusal) => refusal.message);
  assert.equal(new Set(first).size, 3);
  const { host } = fakeX1Validator();
  const before = host.calls.length;
  for (const value of [undefined, null]) {
    const refused = { message: refusalOf(value).message };
    await assert.rejects(configureNginx({ host, key: value }), refused);
  }
  assert.equal(host.calls.length, before);
});
