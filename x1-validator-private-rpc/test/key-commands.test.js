/**
 * @file x1-validator-private-rpc/test/key-commands.test.js
 * @description
 * Tests the commands that read the api key:
 *
 * - unlock, after nginx came back locked, looking at the gate page as
 *   often, and waiting for it as long, as the settings say
 * - url, the only command that shows the key
 * - unlock, url and a second apply, each taking the password as many
 *   times as the settings say
 * - decrypt-key, which refuses a terminal and a wrong password, and
 *   prints the key for the start wrapper
 * - all three with every setting changed, finding the vault and the
 *   hand-off file where the settings put them
 * - their refusal before apply has run, or when the vault holds no key
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { runDecryptKey, runUnlock, runUrl } from "../src/cli/key-commands.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
} from "./helpers/applied-validator.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

test("unlock hands the key to a locked nginx, and nginx opens", async () => {
  const { host, state, settings } = await appliedValidator();
  Object.assign(state, { unlocked: false });
  const run = commandRun(host, settings);
  assert.equal(await runUnlock(run), 0, run.lines.join("\n"));
  assert.equal(state.unlocked, true);
  assert.equal(host.files.has(settings.keyHandOffPath), false);
  assert.ok(
    run.lines.includes(
      "[unlock] nginx holds the key, so keyed requests reach the rpc.",
    ),
  );
  assert.equal(run.lines.join("\n").includes(state.key), false);
});

test("unlock looks at the gate page as often as the settings say", async () => {
  const { host, state, settings: shipped } = await appliedValidator();
  const settings = { ...shipped, gatePollMs: shipped.gatePollMs + 1 };
  Object.assign(state, { unlocked: false });
  const tlsGet = host.tlsGet;
  let looks = 0;
  host.tlsGet = async (target) => {
    looks += 1;
    const answer = await tlsGet(target);
    return looks < 3 ? { ...answer, body: "locked\n" } : answer;
  };
  const pauses = [];
  const sleep = host.sleep;
  host.sleep = (ms) => {
    pauses.push(ms);
    return sleep(ms);
  };
  const run = commandRun(host, settings);
  assert.equal(await runUnlock(run), 0, run.lines.join("\n"));
  assert.deepEqual(pauses, [settings.gatePollMs, settings.gatePollMs]);
});

test("unlock waits for nginx as long as the settings say", async () => {
  const { host, state, settings: shipped } = await appliedValidator();
  const settings = {
    ...shipped,
    requestTimeoutSeconds: shipped.requestTimeoutSeconds * 2,
  };
  Object.assign(state, { unlocked: false });
  const asked = [];
  host.tlsGet = async () => {
    asked.push(host.now());
    return { status: 200, body: "locked\n", certificate: {} };
  };
  const run = commandRun(host, settings);
  assert.equal(await runUnlock(run), 1);
  const waited = asked.at(-1) - asked[0];
  assert.equal(waited, settings.requestTimeoutSeconds * 1000);
});

test("url prints the full https and websocket urls", async () => {
  const { host, state, settings } = await appliedValidator();
  const printed = [];
  const run = commandRun(host, settings, { out: (line) => printed.push(line) });
  assert.equal(await runUrl(run), 0);
  assert.deepEqual(printed, [
    `https://x1-rpc.example.com/${state.key}`,
    `wss://x1-rpc.example.com/${state.key}`,
  ]);
});

test("unlock, url and a second apply take the password as many times as the settings say", async () => {
  /*-
   * A changed count, with the right password on the last try, so code
   * that kept the shipped count, or read none, would stop first.
   */
  const { host, state, settings: shipped } = await appliedValidator();
  const tries = shippedAndChangedSettings().changed.passwordTries;
  const settings = { ...shipped, passwordTries: tries };
  const wrong = Array.from({ length: tries - 1 }, (_, n) => `wrong ${n}`);
  const typed = () => scriptedPrompts({ passwords: [...wrong, PASSWORD] });
  Object.assign(state, { unlocked: false });
  const unlock = commandRun(host, settings, { prompts: typed() });
  assert.equal(await runUnlock(unlock), 0, unlock.lines.join("\n"));
  assert.equal(state.unlocked, true);
  const printed = [];
  const url = commandRun(host, settings, {
    prompts: typed(),
    out: (line) => printed.push(line),
  });
  assert.equal(await runUrl(url), 0);
  assert.equal(printed.length, 2);
  const again = commandRun(host, settings, {
    prompts: typed(),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
});

test("decrypt-key refuses a terminal and a wrong password, and prints the key", async () => {
  const { host, state, settings } = await appliedValidator();
  const written = [];
  const errors = [];
  const run = (stdinText, stdoutIsTerminal) =>
    runDecryptKey({
      host,
      settings,
      stdinText,
      stdoutIsTerminal,
      write: (text) => written.push(text),
      err: (line) => errors.push(line),
    });
  assert.equal(await run(`${PASSWORD}\n`, true), 1);
  assert.deepEqual(errors, [
    "decrypt-key: refusing to print the key to a terminal.",
  ]);
  assert.equal(await run("a wrong password\n", false), 1);
  assert.equal(
    errors.at(-1),
    "decrypt-key: The password is wrong, or the vault is damaged.",
  );
  assert.equal(await run(`${PASSWORD}\n`, false), 0);
  assert.deepEqual(written, [state.key]);
});

test("unlock, url and decrypt-key find the vault and the hand-off file where the settings put them", async () => {
  // Every setting changed, so code that kept a shipped path would fail.
  const { changed } = shippedAndChangedSettings();
  const { host, state, settings } = await appliedValidator({
    settings: { ...changed, hostname: HOSTNAME },
  });
  const { key } = state;
  Object.assign(state, { unlocked: false, key: null });
  const unlock = commandRun(host, settings);
  assert.equal(await runUnlock(unlock), 0, unlock.lines.join("\n"));
  assert.deepEqual([state.unlocked, state.key], [true, key]);
  const printed = [];
  const url = commandRun(host, settings, { out: (line) => printed.push(line) });
  assert.equal(await runUrl(url), 0);
  assert.equal(printed[0], `https://${HOSTNAME}/${key}`);
  const written = [];
  const decrypted = await runDecryptKey({
    host,
    settings,
    stdinText: `${PASSWORD}\n`,
    stdoutIsTerminal: false,
    write: (text) => written.push(text),
    err: () => {},
  });
  assert.equal(decrypted, 0);
  assert.deepEqual(written, [key]);
});

test("unlock and url refuse to run before apply", async () => {
  const { host } = fakeX1Validator();
  for (const command of [runUnlock, runUrl]) {
    await assert.rejects(command(commandRun(host, {})), {
      message: "apply hasn't set nginx up yet. Run apply first.",
    });
  }
});

test("a vault whose key is null holds no key, for every command", async () => {
  const { host, settings } = await appliedValidator();
  const vaultPath = homePath(settings.vaultPath, host.homeDir());
  const vault = JSON.parse(host.files.get(vaultPath));
  const emptied = Object.fromEntries(
    Object.keys(vault.secrets).map((name) => [name, null]),
  );
  host.files.set(vaultPath, JSON.stringify({ ...vault, secrets: emptied }));
  for (const command of [runUnlock, runUrl]) {
    await assert.rejects(command(commandRun(host, settings)), {
      message: `${vaultPath} holds no api key. Run apply.`,
    });
  }
  const errors = [];
  const code = await runDecryptKey({
    host,
    settings,
    paths: featurePaths(),
    stdinText: `${PASSWORD}\n`,
    stdoutIsTerminal: false,
    write: () => {},
    err: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(errors, [`decrypt-key: ${vaultPath} holds no api key.`]);
});
