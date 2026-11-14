/**
 * @file x1-validator-private-rpc/test/small-modules.test.js
 * @description
 * Tests the commands' smaller helpers on a fake host or stand-in
 * streams:
 *
 * - the logger's tags and masking
 * - the tool's state, which refuses a damaged file
 * - the Cronitor check-in, with its retry and a url that never reaches
 *   the log
 * - x1console's Telegram files and the plain-text send
 * - the prompts, with --yes answering only confirmations
 * - the key stage's TPM2 explanations, and the password's length and
 *   tries, as the settings say
 */

import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  askKnownPassword,
  askNewPassword,
  explainTpm2,
} from "../src/cli/apply-key.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { checkIn, CRONITOR_URL, cronitorUrl } from "../src/cli/heartbeat.js";
import { createLog, maskSecret } from "../src/cli/log.js";
import { createPrompts } from "../src/cli/prompts.js";
import { readState } from "../src/cli/state.js";
import {
  CHAT_ID_FILE,
  readTelegram,
  sendTelegram,
  TOKEN_FILE,
} from "../src/cli/telegram.js";
import { encryptSecret } from "../src/cli/vault.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const CRONITOR = "https://cronitor.link/p/SECRETKEY/MONITOR";

/**
 * Makes a logger whose lines the test reads.
 * @returns {{log: object, lines: string[]}}
 */
function readableLog() {
  const lines = [];
  return {
    lines,
    log: createLog({
      out: (line) => lines.push(line),
      err: (line) => lines.push(`ERR ${line}`),
    }),
  };
}

test("the logger tags each line, and masks what it's told to hide", () => {
  const { log, lines } = readableLog();
  const key = "ab".repeat(32);
  log.hide(key);
  log.hide("abc");
  log.info("nginx", `started with ${key}`);
  log.problem("alert", "abc stays, too short to be a secret");
  assert.deepEqual(lines, [
    `[nginx] started with ${maskSecret(key)}`,
    "ERR [alert] abc stays, too short to be a secret",
  ]);
  assert.equal(maskSecret(key), "…abab");
});

test("the tool's state: none before apply, a damaged file refused", () => {
  const host = createFakeHost({ respond: () => undefined });
  const { statePath } = featurePaths();
  assert.equal(readState(host, statePath), null);
  host.files.set(statePath, "{ damaged");
  assert.throws(() => readState(host, statePath), {
    message: /isn't valid json/,
  });
  host.files.set(statePath, '{"version": 9}');
  assert.throws(() => readState(host, statePath), {
    message: /isn't a state this tool wrote/,
  });
});

test("the Cronitor url comes from .env, and the check-in retries once", async () => {
  const fetched = [];
  let answers = [500, 200];
  const host = createFakeHost({
    respond: () => undefined,
    httpsGet: async (url) => {
      fetched.push(url);
      return { status: answers.shift() ?? 200, body: "" };
    },
  });
  const { envPath } = featurePaths();
  assert.equal(cronitorUrl(host, envPath), null);
  host.files.set(envPath, `${CRONITOR_URL}=\n`);
  assert.equal(cronitorUrl(host, envPath), null);
  const { log, lines } = readableLog();
  assert.equal(await checkIn(host, { envPath, log, timeoutMs: 1000 }), null);
  host.files.set(envPath, `${CRONITOR_URL}=${CRONITOR}\n`);
  assert.equal(await checkIn(host, { envPath, log, timeoutMs: 1000 }), true);
  assert.deepEqual(fetched, [
    `${CRONITOR}?state=complete`,
    `${CRONITOR}?state=complete`,
  ]);
  assert.deepEqual(lines, [
    "ERR [heartbeat] Cronitor's check-in, try 1 of 2, answered http 500.",
  ]);
  answers = [502, 503];
  assert.equal(await checkIn(host, { envPath, log, timeoutMs: 1000 }), false);
  assert.equal(lines.join("\n").includes("SECRETKEY"), false);
});

test("Telegram: x1console's two files, and a plain-text send", async () => {
  const posts = [];
  const host = createFakeHost({
    respond: () => undefined,
    postJson: async (url, body) => {
      posts.push({ url, body });
      return { status: posts.length === 1 ? 200 : 401, body: "" };
    },
  });
  // A changed folder, to show the files are read where the settings say.
  const { changed: settings } = shippedAndChangedSettings();
  const homeDir = host.homeDir();
  const x1consoleDir = homePath(settings.x1consoleDir, homeDir);
  assert.equal(readTelegram(host, settings), null);
  host.files.set(path.join(x1consoleDir, TOKEN_FILE), "123:token\n");
  assert.equal(readTelegram(host, settings), null);
  host.files.set(path.join(x1consoleDir, CHAT_ID_FILE), " 42 \n");
  const telegram = readTelegram(host, settings);
  assert.deepEqual(telegram, { token: "123:token", chatId: "42" });
  await sendTelegram(host, telegram, "Hello *there*", 1000);
  assert.deepEqual(posts[0], {
    url: "https://api.telegram.org/bot123:token/sendMessage",
    body: { chat_id: "42", text: "Hello *there*" },
  });
  await assert.rejects(sendTelegram(host, telegram, "again", 1000), {
    message: "Telegram answered http 401.",
  });
});

test("the prompts: --yes answers confirmations, never a choice; the password stays hidden", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  const prompts = createPrompts({ yes: true, input, output });
  assert.equal(await prompts.confirm("Go on?"), true);
  assert.equal(shown, "");
  const choice = prompts.ask("Save the password?");
  input.write("yes\n");
  assert.equal(await choice, true);
  const declined = prompts.ask("Save the password?");
  input.write("nope\n");
  assert.equal(await declined, false);
  const asking = createPrompts({ yes: false, input, output });
  const confirmed = asking.confirm("Stage 2 of 8: install nginx. Go on?");
  input.write("y\n");
  assert.equal(await confirmed, true);
  const password = asking.password("Password: ");
  input.write("hunter2 hunter2\n");
  assert.equal(await password, "hunter2 hunter2");
  asking.say("A line.");
  assert.equal(shown.includes("hunter2"), false);
  assert.ok(shown.endsWith("Password: \nA line.\n"));
});

test("explains systemd's three TPM2 answers", () => {
  assert.match(explainTpm2("yes\n+firmware\n"), /tied to the chip/);
  assert.match(
    explainTpm2(
      "partial\n+firmware\n+driver\n+system\n+subsystem\n-libraries\n",
    ),
    /Install libtss2-esys-3\.0\.2-0t64/,
  );
  assert.match(
    explainTpm2(
      "partial\n-firmware\n-driver\n+system\n+subsystem\n-libraries\n",
    ),
    /no usable TPM2 chip/,
  );
  assert.match(explainTpm2("no\n"), /no usable TPM2 chip/);
});

test("a password may be typed as many times as the settings say, and the last wrong one stops", async () => {
  // A changed count, so code that kept the shipped one would show.
  const tries = shippedAndChangedSettings().changed.passwordTries;
  const payload = await encryptSecret("the key", "the right password", 1000);
  const wrong = Array.from({ length: tries - 1 }, (_, index) => `no ${index}`);
  const prompts = scriptedPrompts({
    passwords: [...wrong, "the right password"],
  });
  assert.deepEqual(await askKnownPassword(prompts, payload, tries), {
    password: "the right password",
    plain: "the key",
  });
  assert.ok(
    prompts.asked.includes(
      "The password is wrong, or the vault is damaged. 1 more tries.",
    ),
  );
  const stubborn = scriptedPrompts({ passwords: [...wrong, "wrong too"] });
  await assert.rejects(askKnownPassword(stubborn, payload, tries), {
    message: "The password is wrong, or the vault is damaged.",
  });
});

test("a new password needs as many characters as the settings say, typed the same twice", async () => {
  // Changed values, so code that kept the shipped ones would show.
  const { changed } = shippedAndChangedSettings();
  const length = changed.passwordMinLength;
  const short = "s".repeat(length - 1);
  const long = "l".repeat(length);
  const prompts = scriptedPrompts({
    passwords: [short, short, long, `${long}!`, long, long],
  });
  assert.equal(await askNewPassword(prompts, changed), long);
  assert.ok(
    prompts.asked.includes(
      `The password must have at least ${length} characters.`,
    ),
  );
  assert.ok(prompts.asked.includes("The two passwords differ."));
  const unlucky = Array.from(
    { length: changed.passwordTries * 2 },
    () => short,
  );
  await assert.rejects(
    askNewPassword(scriptedPrompts({ passwords: unlucky }), changed),
    { message: "No usable password was typed." },
  );
});
