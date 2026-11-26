/**
 * @file x1-validator-private-rpc/test/small-modules.test.js
 * @description
 * Tests the commands' smaller helpers on a fake host or stand-in
 * streams:
 *
 * - the logger's tags and masking
 * - the tool's state, which refuses a damaged file
 * - the Cronitor check-in, tried as many times as the settings say, with
 *   a url that never reaches the log, and each try that gets no answer
 *   logged with the reason. Under --quiet, the failed tries are logged
 *   only when the check-ins start failing, and a check-in that goes
 *   through again says so
 * - the project's .env.example, which the operator copies to .env: it
 *   sits where the tool looks for .env, and names the Cronitor url as
 *   the tool reads it
 * - x1console's Telegram files, under x1console's own names, and the
 *   plain-text send
 * - the prompts, with --yes answering only confirmations, and a line's
 *   prompt that fails at a Ctrl-C or the end of its input
 * - the key stage's TPM2 explanations, and the password's length and
 *   tries, as the settings say
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  askKnownPassword,
  askNewPassword,
  explainTpm2,
} from "../src/cli/apply-key.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import {
  newHashedApiKeys,
  WRONG_PASSWORD,
} from "../src/cli/hashed-api-keys.js";
import { checkIn, CRONITOR_URL, cronitorUrl } from "../src/cli/heartbeat.js";
import { createLog } from "../src/cli/log.js";
import { createPrompts } from "../src/cli/prompts.js";
import { emptyState, readState } from "../src/cli/state.js";
import { readTelegram, sendTelegram } from "../src/cli/telegram.js";
import { askLine, PROMPT_STOPPED } from "../src/lib/ask-line.js";
import { maskSecret } from "../src/lib/mask-secret.js";
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

test("the tool's state: none before apply, a damaged file refused, and a field newer than the file filled in", () => {
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
  // Written before savedPasswordStale existed.
  const older = { ...emptyState(), privateRpc: "on" };
  delete older.savedPasswordStale;
  host.files.set(statePath, JSON.stringify(older));
  assert.deepEqual(readState(host, statePath), {
    ...emptyState(),
    privateRpc: "on",
  });
});

test("the Cronitor url comes from .env, and the check-in is tried as many times as the settings say", async () => {
  // A changed count, so code that kept the shipped one would show.
  const tries = shippedAndChangedSettings().changed.cronitorCheckInTries;
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
  const values = { envPath, log, timeoutMs: 1000, tries };
  assert.equal(await checkIn(host, values), null);
  host.files.set(envPath, `${CRONITOR_URL}=${CRONITOR}\n`);
  assert.equal(await checkIn(host, values), true);
  assert.deepEqual(fetched, [
    `${CRONITOR}?state=complete`,
    `${CRONITOR}?state=complete`,
  ]);
  assert.deepEqual(lines, [
    `ERR [heartbeat] Cronitor's check-in, try 1 of ${tries}, answered http 500.`,
  ]);
  // Every try fails, then a good answer, so more tries would succeed.
  answers = Array.from({ length: tries }, () => 503);
  fetched.length = 0;
  assert.equal(await checkIn(host, values), false);
  assert.equal(fetched.length, tries);
  assert.equal(lines.join("\n").includes("SECRETKEY"), false);
});

test("a check-in try that gets no answer is logged with the reason, and under --quiet the failed tries are logged only when the check-ins start failing", async () => {
  // A changed count, so code that kept the shipped one would show.
  const tries = shippedAndChangedSettings().changed.cronitorCheckInTries;
  const unknownName = "getaddrinfo ENOTFOUND cronitor.link";
  let answer = async () => {
    throw new Error(unknownName);
  };
  const host = createFakeHost({
    respond: () => undefined,
    httpsGet: () => answer(),
  });
  const { envPath } = featurePaths();
  host.files.set(envPath, `${CRONITOR_URL}=${CRONITOR}\n`);
  const { log, lines } = readableLog();
  const values = { envPath, log, timeoutMs: 1000, tries };
  const each = Array.from(
    { length: tries },
    (_, index) =>
      `ERR [heartbeat] Cronitor's check-in, try ${index + 1} of ${tries}, got no answer: ${unknownName}`,
  );
  // A run by hand logs every failed try, whatever the last run found.
  const byHand = { ...values, quiet: false, failedBefore: true };
  assert.equal(await checkIn(host, byHand), false);
  assert.deepEqual(lines, each);
  lines.length = 0;
  const quiet = { ...values, quiet: true };
  assert.equal(await checkIn(host, { ...quiet, failedBefore: false }), false);
  assert.deepEqual(lines, each);
  lines.length = 0;
  assert.equal(await checkIn(host, { ...quiet, failedBefore: true }), false);
  assert.deepEqual(lines, []);
  answer = async () => ({ status: 200, body: "" });
  assert.equal(await checkIn(host, { ...quiet, failedBefore: true }), true);
  assert.deepEqual(lines, [
    "[heartbeat] Cronitor's check-in went through again.",
  ]);
});

test("the project's .env.example sits where the tool looks for .env, and names the Cronitor url as the tool reads it", () => {
  // The operator makes .env with cp .env.example .env, as the root
  // README's Credentials says, so the example ties both names.
  const example = readFileSync(`${featurePaths().envPath}.example`, "utf8");
  assert.match(example, new RegExp(`^${CRONITOR_URL}=`, "m"));
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
  // x1console's own names for the files, not the tool's constants.
  host.files.set(path.join(x1consoleDir, "telegram_token.txt"), "123:token\n");
  assert.equal(readTelegram(host, settings), null);
  host.files.set(path.join(x1consoleDir, "chat_id.txt"), " 42 \n");
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

test("the prompts: --yes answers confirmations, never a choice or a line; the password stays hidden", async () => {
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
  const line = prompts.line("An email: ");
  input.write("you@example.com\n");
  assert.equal(await line, "you@example.com");
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

test("a Ctrl-C at a line's prompt on a terminal, or the end of its input, fails the prompt after a line break, so the program can stop with exit code 1", async () => {
  const input = new PassThrough();
  // Stands in for a terminal, so readline reads each key itself.
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  /*-
   * Each prompt's failure is read once the streams have delivered what
   * the test wrote, not awaited, since a prompt left waiting would never
   * settle.
   */
  const failures = [];
  askLine("The rpc's hostname: ", { input, output }).catch((error) => {
    failures.push(error.message);
  });
  input.write("x1-rpc\x03");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [PROMPT_STOPPED]);
  assert.ok(shown.endsWith("\n"), JSON.stringify(shown));
  const ending = new PassThrough();
  askLine("An email: ", { input: ending, output }).catch((error) => {
    failures.push(error.message);
  });
  ending.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [PROMPT_STOPPED, PROMPT_STOPPED]);
});

test("explains systemd's three TPM2 answers", () => {
  assert.match(explainTpm2("yes\n+firmware\n"), /tied to the chip/);
  assert.match(
    explainTpm2(
      "partial\n+firmware\n+driver\n+system\n+subsystem\n-libraries\n",
    ),
    /install libtss2-esys-3\.0\.2-0t64, .* before you answer, since apply asks this only once\.$/,
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
  const { keys, cipherKey } = await newHashedApiKeys("the right password", 1);
  const wrong = Array.from({ length: tries - 1 }, (_, index) => `no ${index}`);
  const prompts = scriptedPrompts({
    passwords: [...wrong, "the right password"],
  });
  assert.deepEqual(await askKnownPassword(prompts, keys, tries), {
    password: "the right password",
    cipherKey,
  });
  assert.ok(prompts.asked.includes(`${WRONG_PASSWORD} 2 more tries.`));
  assert.ok(prompts.asked.includes(`${WRONG_PASSWORD} 1 more try.`));
  const stubborn = scriptedPrompts({ passwords: [...wrong, "wrong too"] });
  await assert.rejects(askKnownPassword(stubborn, keys, tries), {
    message: WRONG_PASSWORD,
  });
});

test("a new password needs as many characters as the settings say, typed the same twice, within as many tries", async () => {
  /*-
   * Changed values, so code that kept the shipped ones would show. The
   * good pair comes on the last try, after failed tries of both kinds,
   * so code that allowed fewer tries would stop first.
   */
  const { changed } = shippedAndChangedSettings();
  const length = changed.passwordMinLength;
  const short = "s".repeat(length - 1);
  const long = "l".repeat(length);
  const failed = Array.from({ length: changed.passwordTries - 1 }, (_, n) =>
    n % 2 === 0 ? [short, short] : [long, `${long}!`],
  ).flat();
  const prompts = scriptedPrompts({ passwords: [...failed, long, long] });
  assert.equal(await askNewPassword(prompts, changed), long);
  assert.ok(
    prompts.asked.includes(
      `The password must have at least ${length} characters.`,
    ),
  );
  assert.ok(prompts.asked.includes("The two passwords differ."));
  // A good pair after the last try, so code that allowed more would take it.
  const unlucky = [
    ...Array.from({ length: changed.passwordTries * 2 }, () => short),
    long,
    long,
  ];
  await assert.rejects(
    askNewPassword(scriptedPrompts({ passwords: unlucky }), changed),
    { message: "No usable password was typed." },
  );
});
