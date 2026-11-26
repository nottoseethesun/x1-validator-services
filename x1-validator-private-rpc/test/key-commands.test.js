/**
 * @file x1-validator-private-rpc/test/key-commands.test.js
 * @description
 * Tests the commands for the api keys, on a fake validator that apply
 * set up:
 *
 * - add-api-key: --count, and an email asked after the password. It asks
 *   again after an answer that isn't an email, and takes Enter as none.
 *   Each new key is shown once, under the hostname nginx serves, before
 *   nginx's list is written, and its record is encrypted. nginx takes the
 *   new keys at once. The password is taken as many times as the
 *   settings say, and a count past maxApiKeys is refused.
 * - remove-api-key: a pasted key removed with no password, nginx
 *   refusing it at once, a key that isn't there, a text that isn't a
 *   key, and the last key, which asks first
 * - both holding the api keys' lock around their writes, add-api-key
 *   holding it while it asks for the password too, and both refusing,
 *   with nothing changed, while another command holds it
 * - both getting sudo after their questions and before their first
 *   write, so a refused sudo changes nothing
 * - remove-api-key handing nginx the list before it writes the file.
 *   When either write fails, running it again removes the key. A failed
 *   write of the file says to run it again before any other command
 *   writes the list.
 * - url: the two url forms, under the hostname nginx serves, and the
 *   number of keys, with no password
 * - ensure-there-is-at-least-one-rpc-api-key: an alert on every run
 *   while nginx's list is empty, and quiet while it holds a key, with no
 *   question and no sudo, and the hostname nginx serves in its alert
 * - each finding its files where the settings put them, and
 *   remove-api-key writing its change to the configured file
 * - before apply, add-api-key, remove-api-key and url refusing to run,
 *   and ensure-there-is-at-least-one-rpc-api-key doing nothing
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  EMAIL_PROMPT,
  NOT_AN_EMAIL,
  runAddApiKey,
} from "../src/cli/add-api-key.js";
import { PASSWORD_PROMPT } from "../src/cli/apply-key.js";
import { runEnsureApiKey } from "../src/cli/ensure-there-is-at-least-one-rpc-api-key.js";
import { hashedApiKeysPathOf } from "../src/cli/feature-paths.js";
import {
  KEYS_LOCKED,
  NO_API_KEY,
  openHashedApiKeys,
  readHashedApiKeys,
  readRecord,
  WRONG_PASSWORD,
} from "../src/cli/hashed-api-keys.js";
import { runUrl } from "../src/cli/key-commands.js";
import {
  halfRemoved,
  REMOVE_KEY_PROMPT,
  runRemoveApiKey,
} from "../src/cli/remove-api-key.js";
import { API_KEY_HEX_DIGITS } from "../src/lib/api-key.js";
import { hashApiKey } from "../src/lib/key-hash-map.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
  printedKeys,
} from "./helpers/applied-validator.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { sudoCalls } from "./helpers/fake-host.js";
import {
  ANOTHER_HOSTNAME,
  fakeX1Validator,
  HOME,
  HOSTNAME,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs add-api-key.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} [more]  The options and the prompts.
 * @returns {Promise<object>} The run, with its exit code as `code`.
 */
async function addKeys(host, settings, more = {}) {
  const given = more.prompts;
  const run = commandRun(host, settings, {
    options: { count: 1, ...more.options },
    ...(given === undefined || given === null ? {} : { prompts: given }),
  });
  run.code = await runAddApiKey(run);
  return run;
}

/**
 * Tells whether a run took the api keys' lock before its writes of the
 * keys' file and nginx's list, and let it go only after both.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {number} from  How many calls the host had before the run.
 * @returns {boolean}
 */
function lockedAroundWrites(host, settings, from) {
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const folder = path.dirname(filePath);
  const calls = host.calls.slice(from);
  const at = (kind, target) =>
    calls.findIndex((call) => call.kind === kind && call.path === target);
  const locked = at("lockFolder", folder);
  const unlocked = at("unlockFolder", folder);
  const writes = [
    at("writeUserFile", filePath),
    at("writeRootFile", settings.hashedApiKeysMapPath),
  ];
  return (
    locked >= 0 &&
    writes.every((write) => write > locked && write < unlocked) &&
    host.locks.size === 0
  );
}

/**
 * Runs the key count check, and checks that it asked nothing and used no
 * sudo, since cron runs it with nobody at the terminal. The settings name
 * another hostname than apply set nginx up with, which its alert must
 * not name.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {boolean} quiet  Whether it runs with --quiet.
 * @returns {Promise<object>} The run, with its exit code as `code`.
 */
async function countKeys(host, settings, quiet) {
  const from = host.calls.length;
  const later = { ...settings, hostname: ANOTHER_HOSTNAME };
  const prompts = scriptedPrompts();
  const run = commandRun(host, later, { prompts, options: { quiet } });
  run.code = await runEnsureApiKey(run);
  const rooted = sudoCalls(host.calls.slice(from));
  assert.deepEqual([prompts.asked, rooted], [[], []]);
  return run;
}

/**
 * Runs remove-api-key, pasting a key.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {string} pasted  What's pasted at the prompt.
 * @param {boolean} [yes]  The answer to the last key's question.
 * @returns {Promise<object>} The run, with its exit code as `code` and
 *   its prompts.
 */
async function removeKey(host, settings, pasted, yes = false) {
  const prompts = scriptedPrompts({ ask: () => yes, passwords: [pasted] });
  const run = commandRun(host, settings, { prompts });
  run.code = await runRemoveApiKey(run);
  run.prompts = prompts;
  return run;
}

test("add-api-key makes as many keys as --count says, shows each once, and nginx takes them at once", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  const from = host.calls.length;
  const run = await addKeys(host, settings, {
    options: { count: 2 },
    prompts: scriptedPrompts({
      passwords: [PASSWORD],
      lines: ["you@example.com"],
    }),
  });
  assert.equal(run.code, 0, run.lines.join("\n"));
  assert.equal(lockedAroundWrites(host, settings, from), true);
  const made = printedKeys(run.printed);
  assert.equal(made.length, 2);
  assert.deepEqual(
    run.printed,
    made.flatMap((key) => [
      `https://${HOSTNAME}/${key}`,
      `wss://${HOSTNAME}/${key}`,
    ]),
  );
  assert.equal(
    made.some((key) => run.lines.join("\n").includes(key)),
    false,
  );
  assert.deepEqual(
    state.loadedHashes,
    [apiKey, ...made].map((key) => hashApiKey(key)),
  );
  assert.ok(run.lines.includes("[add-api-key] 3 api keys in all."));
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const keys = readHashedApiKeys(host, filePath);
  const cipherKey = await openHashedApiKeys(keys, PASSWORD);
  for (const key of made) {
    const record = readRecord(keys, cipherKey, hashApiKey(key));
    assert.deepEqual(record, {
      createdAtTimestampMS: host.now(),
      email: "you@example.com",
    });
  }
  // Every value is encrypted, so no record shows the email in the clear.
  assert.equal(host.files.get(filePath).includes("you@example.com"), false);
});

test("add-api-key asks for an email after the password, asks again after an answer that isn't one, and takes Enter as none", async () => {
  const { host, settings } = await appliedValidator();
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const emailOf = async (run) => {
    const [key] = printedKeys(run.printed);
    const keys = readHashedApiKeys(host, filePath);
    const cipherKey = await openHashedApiKeys(keys, PASSWORD);
    return readRecord(keys, cipherKey, hashApiKey(key)).email;
  };
  const prompts = scriptedPrompts({
    passwords: [PASSWORD],
    lines: ["not an email", " you@example.com "],
  });
  const typed = await addKeys(host, settings, { prompts });
  assert.equal(typed.code, 0, typed.lines.join("\n"));
  assert.deepEqual(prompts.asked, [
    PASSWORD_PROMPT,
    EMAIL_PROMPT,
    NOT_AN_EMAIL,
    EMAIL_PROMPT,
  ]);
  assert.equal(await emailOf(typed), "you@example.com");
  const none = await addKeys(host, settings);
  assert.equal(none.code, 0, none.lines.join("\n"));
  assert.equal(await emailOf(none), "");
});

test("add-api-key takes the password as many times as the settings say", async () => {
  // A changed count, with the right password last, so a kept count shows.
  const { host, settings: shipped } = await appliedValidator();
  const tries = shippedAndChangedSettings().changed.passwordTries;
  const settings = { ...shipped, passwordTries: tries };
  const wrong = Array.from({ length: tries - 1 }, (_, n) => `wrong ${n}`);
  const run = await addKeys(host, settings, {
    prompts: scriptedPrompts({ passwords: [...wrong, PASSWORD] }),
  });
  assert.equal(run.code, 0, run.lines.join("\n"));
  const stubborn = addKeys(host, settings, {
    prompts: scriptedPrompts({ passwords: [...wrong, "wrong too"] }),
  });
  await assert.rejects(stubborn, { message: WRONG_PASSWORD });
  // A run that fails still lets the lock go.
  assert.equal(host.locks.size, 0);
});

test("add-api-key refuses keys past maxApiKeys, before asking for the password", async () => {
  const { host, settings: shipped } = await appliedValidator();
  // A small configured cap, so a check against the shipped one shows.
  const settings = { ...shipped, maxApiKeys: 3 };
  const prompts = scriptedPrompts({ passwords: [PASSWORD] });
  const options = { count: 3 };
  await assert.rejects(addKeys(host, settings, { options, prompts }), {
    message:
      `${hashedApiKeysPathOf(settings, HOME)} holds 1 api key, and ` +
      "maxApiKeys is 3, so 2 more fit, not 3.",
  });
  assert.deepEqual(prompts.asked, []);
  const fits = await addKeys(host, settings, { options: { count: 2 } });
  assert.equal(fits.code, 0, fits.lines.join("\n"));
});

test("add-api-key's urls name the hostname nginx serves, not one changed in the settings since apply", async () => {
  const { host, settings: applied } = await appliedValidator();
  const settings = { ...applied, hostname: ANOTHER_HOSTNAME };
  const run = await addKeys(host, settings);
  assert.equal(run.code, 0, run.lines.join("\n"));
  const [key] = printedKeys(run.printed);
  assert.deepEqual(run.printed, [
    `https://${HOSTNAME}/${key}`,
    `wss://${HOSTNAME}/${key}`,
  ]);
});

test("add-api-key shows the new keys before it writes nginx's list, so a failed write of the list loses no key unseen", async () => {
  const { host, settings } = await appliedValidator();
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, ...rest) => {
    if (filePath === settings.hashedApiKeysMapPath) {
      throw new Error("No space left on device");
    }
    return writeRootFile(filePath, ...rest);
  };
  const run = commandRun(host, settings, { options: { count: 1 } });
  await assert.rejects(runAddApiKey(run), {
    message: "No space left on device",
  });
  const made = printedKeys(run.printed);
  assert.equal(made.length, 1, run.lines.join("\n"));
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const keys = readHashedApiKeys(host, filePath);
  assert.ok(keys.records.has(hashApiKey(made[0])));
  assert.equal(host.locks.size, 0);
});

test("add-api-key and remove-api-key refuse, with nothing changed, while another command holds the api keys' lock, and add-api-key holds the lock while it asks for the password", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const folder = path.dirname(filePath);
  const before = host.files.get(filePath);
  const release = host.lockFolder(folder);
  const prompts = scriptedPrompts({ passwords: [PASSWORD] });
  await assert.rejects(addKeys(host, settings, { prompts }), {
    message: KEYS_LOCKED,
  });
  await assert.rejects(removeKey(host, settings, apiKey, true), {
    message: KEYS_LOCKED,
  });
  assert.deepEqual(prompts.asked, []);
  assert.equal(host.files.get(filePath), before);
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  release();
  const heldAtPrompt = [];
  const watched = scriptedPrompts({ passwords: [PASSWORD] });
  const typed = watched.password;
  watched.password = async (prompt) => {
    heldAtPrompt.push(host.locks.has(folder));
    return typed(prompt);
  };
  const added = await addKeys(host, settings, { prompts: watched });
  assert.equal(added.code, 0, added.lines.join("\n"));
  assert.deepEqual(heldAtPrompt, [true]);
  assert.equal(host.locks.size, 0);
});

test("remove-api-key removes a pasted key with no password, and nginx refuses it at once", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  const added = await addKeys(host, settings);
  const [second] = printedKeys(added.printed);
  const from = host.calls.length;
  const run = await removeKey(host, settings, ` ${second}\n`);
  assert.equal(run.code, 0, run.lines.join("\n"));
  assert.equal(lockedAroundWrites(host, settings, from), true);
  assert.deepEqual(run.prompts.asked, [REMOVE_KEY_PROMPT]);
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  assert.ok(
    run.lines.includes(
      `[remove-api-key] Removed the api key …${second.slice(-4)}. 1 api key left.`,
    ),
    run.lines.join("\n"),
  );
  assert.equal(run.lines.join("\n").includes(second), false);
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const keys = readHashedApiKeys(host, filePath);
  assert.deepEqual([...keys.records.keys()], [hashApiKey(apiKey)]);
});

test("remove-api-key removes nothing for a key that isn't there, or a text that isn't a key, and never repeats it", async () => {
  const { host, settings, apiKey } = await appliedValidator();
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const before = host.files.get(filePath);
  const stranger = "0".repeat(API_KEY_HEX_DIGITS);
  const missing = await removeKey(host, settings, stranger);
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.lines, [
    `[remove-api-key] That api key isn't in ${filePath}. Nothing was removed.`,
  ]);
  const typo = `${apiKey.slice(0, -1)}G`;
  const malformed = await removeKey(host, settings, typo);
  assert.equal(malformed.code, 1);
  assert.deepEqual(malformed.lines, [
    `[remove-api-key] That isn't an api key: a key is ${API_KEY_HEX_DIGITS} lower-case hex ` +
      "characters. Nothing was removed.",
  ]);
  assert.equal(host.files.get(filePath), before);
});

test("remove-api-key asks before the last key goes, and nginx's list then holds none", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  const kept = await removeKey(host, settings, apiKey, false);
  assert.equal(kept.code, 1);
  assert.ok(
    kept.prompts.asked.at(-1).startsWith("This is the last api key."),
    kept.prompts.asked.join("\n"),
  );
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  const removed = await removeKey(host, settings, apiKey, true);
  assert.equal(removed.code, 0, removed.lines.join("\n"));
  assert.deepEqual(state.loadedHashes, []);
  assert.ok(removed.lines.includes(`[remove-api-key] ${NO_API_KEY}`));
});

test("add-api-key and remove-api-key get sudo after their questions and before their first write, so a refused sudo changes nothing", async () => {
  let refuse = true;
  const { host, state, settings, apiKey } = await appliedValidator({
    respond: (call) =>
      refuse === true && call.kind === "sudo" && call.command === "true"
        ? { status: 1, stderr: "sudo: 3 incorrect password attempts" }
        : undefined,
  });
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const before = host.files.get(filePath);
  const from = host.calls.length;
  const refusal = {
    message:
      "Getting sudo before changing anything failed with exit code 1: " +
      "sudo: 3 incorrect password attempts",
  };
  const add = commandRun(host, settings, { options: { count: 1 } });
  await assert.rejects(runAddApiKey(add), refusal);
  assert.deepEqual(add.prompts.asked, [PASSWORD_PROMPT, EMAIL_PROMPT]);
  assert.deepEqual(add.printed, []);
  const prompts = scriptedPrompts({ ask: () => true, passwords: [apiKey] });
  const remove = commandRun(host, settings, { prompts });
  await assert.rejects(runRemoveApiKey(remove), refusal);
  // Both its questions came first: the paste, and the last key's.
  assert.equal(prompts.asked.length, 2, prompts.asked.join("\n"));
  const writes = host.calls
    .slice(from)
    .filter((call) => call.kind.startsWith("write"));
  assert.deepEqual(writes, []);
  assert.equal(host.files.get(filePath), before);
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  assert.equal(host.locks.size, 0);
  refuse = false;
  const again = await removeKey(host, settings, apiKey, true);
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.deepEqual(state.loadedHashes, []);
});

test("remove-api-key hands nginx the list before it writes the api keys' file, so when either write fails, running it again removes the key", async () => {
  const { host, state, settings, apiKey } = await appliedValidator();
  const added = await addKeys(host, settings);
  const [second] = printedKeys(added.printed);
  const filePath = hashedApiKeysPathOf(settings, HOME);
  const before = host.files.get(filePath);
  const diskFull = { message: "No space left on device" };
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = () => {
    throw new Error(diskFull.message);
  };
  await assert.rejects(removeKey(host, settings, second), diskFull);
  host.writeRootFile = writeRootFile;
  // Nothing changed, so nginx still takes the key.
  assert.equal(host.files.get(filePath), before);
  assert.deepEqual(
    state.loadedHashes,
    [apiKey, second].map((key) => hashApiKey(key)),
  );
  const writeUserFile = host.writeUserFile;
  host.writeUserFile = () => {
    throw new Error(diskFull.message);
  };
  await assert.rejects(removeKey(host, settings, second), {
    message: halfRemoved(filePath, diskFull.message),
  });
  host.writeUserFile = writeUserFile;
  // nginx refuses the key already, and the file still holds it.
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  assert.equal(host.files.get(filePath), before);
  const again = await removeKey(host, settings, second);
  assert.equal(again.code, 0, again.lines.join("\n"));
  const keys = readHashedApiKeys(host, filePath);
  assert.deepEqual([...keys.records.keys()], [hashApiKey(apiKey)]);
  assert.equal(host.locks.size, 0);
});

test("url prints the two url forms, under the hostname nginx serves, and the number of keys, and asks nothing", async () => {
  const { host, settings } = await appliedValidator();
  await addKeys(host, settings, { options: { count: 2 } });
  const prompts = scriptedPrompts();
  // A hostname changed in the settings since apply, so a read of it shows.
  const later = { ...settings, hostname: ANOTHER_HOSTNAME };
  const run = commandRun(host, later, { prompts });
  assert.equal(await runUrl(run), 0);
  assert.deepEqual(run.printed, [
    `https://${HOSTNAME}/KEY`,
    `wss://${HOSTNAME}/KEY`,
    "With an api key in place of KEY. nginx's list holds 3 api keys.",
  ]);
  assert.deepEqual(prompts.asked, []);
});

test("the key count check alerts on every run while nginx's list is empty, and stays quiet while it holds a key", async () => {
  const { host, settings, apiKey } = await appliedValidator({
    telegram: true,
  });
  const check = (quiet) => countKeys(host, settings, quiet);
  const sent = () =>
    host.posts
      .filter((post) => post.url.includes("api.telegram.org"))
      .map((post) => post.body.text);
  const before = sent().length;
  const fine = await check(true);
  assert.deepEqual([fine.code, fine.lines], [0, []]);
  const loud = await check(false);
  assert.deepEqual(loud.lines, ["[api keys] nginx's list holds 1 api key."]);
  await removeKey(host, settings, apiKey, true);
  const alert = `x1-validator-private-rpc on ${HOSTNAME}: ${NO_API_KEY}`;
  for (let run = 0; run < 2; run++) {
    const empty = await check(true);
    assert.equal(empty.code, 1);
    assert.deepEqual(empty.lines, [`[alert] ${alert}`]);
  }
  assert.deepEqual(sent().slice(before), [alert, alert]);
});

test("without Telegram, the key count check logs the alert and says alerts are off", async () => {
  const { host, settings, apiKey } = await appliedValidator();
  await removeKey(host, settings, apiKey, true);
  const run = await countKeys(host, settings, true);
  assert.equal(run.code, 1);
  assert.deepEqual(run.lines, [
    `[alert] x1-validator-private-rpc on ${HOSTNAME}: ${NO_API_KEY} ` +
      "(alerts are off: x1console's Telegram files are missing)",
  ]);
});

test("the key commands find their files where the settings put them", async () => {
  // Every setting changed, so code that kept a shipped path would fail.
  const { changed } = shippedAndChangedSettings();
  const { host, state, settings, apiKey } = await appliedValidator({
    settings: { ...changed, hostname: HOSTNAME },
  });
  const added = await addKeys(host, settings);
  const [second] = printedKeys(added.printed);
  assert.ok(host.files.has(hashedApiKeysPathOf(changed, HOME)));
  assert.match(
    host.files.get(changed.hashedApiKeysMapPath),
    new RegExp(hashApiKey(second)),
  );
  const url = commandRun(host, settings);
  assert.equal(await runUrl(url), 0);
  assert.equal(url.printed.at(-1).endsWith("holds 2 api keys."), true);
  const removed = await removeKey(host, settings, second);
  assert.equal(removed.code, 0, removed.lines.join("\n"));
  assert.deepEqual(state.loadedHashes, [hashApiKey(apiKey)]);
  /*-
   * The removal reaches the configured file, which every later command
   * writes nginx's list from.
   */
  const kept = readHashedApiKeys(host, hashedApiKeysPathOf(changed, HOME));
  assert.deepEqual([...kept.records.keys()], [hashApiKey(apiKey)]);
  const count = await countKeys(host, settings, false);
  assert.equal(count.code, 0);
});

test("the key commands refuse to run before apply, and the key count check does nothing", async () => {
  const { host } = fakeX1Validator();
  const settings = shippedAndChangedSettings().shipped;
  const runs = [
    () => addKeys(host, settings),
    () => removeKey(host, settings, "0".repeat(API_KEY_HEX_DIGITS)),
    () => runUrl(commandRun(host, settings)),
  ];
  for (const command of runs) {
    await assert.rejects(command(), {
      message: "apply hasn't set nginx up yet. Run apply first.",
    });
  }
  const count = await countKeys(host, settings, false);
  assert.equal(count.code, 0);
  assert.deepEqual(count.lines, []);
});
