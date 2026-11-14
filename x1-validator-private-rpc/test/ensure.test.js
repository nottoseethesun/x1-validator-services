/**
 * @file x1-validator-private-rpc/test/ensure.test.js
 * @description
 * Tests ensure on a fake validator that apply set up:
 *
 * - nothing before apply
 * - the flag put back after an update, with one notice
 * - an update waited out, for as long as the settings say, unless the
 *   git hook runs ensure
 * - the reason the flag couldn't go back, in the alert
 * - a public rpc's alert and its repeats, as often as the settings say
 * - the certificate's warning, as many days ahead as they say
 * - requests that wait as long as they say
 * - an alert Telegram didn't take, sent at the next run
 * - a damaged alert state, set aside for a fresh one
 * - the Cronitor check-in, and what --quiet prints
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEVER_ALERTED } from "../src/cli/alerts.js";
import { runEnsure } from "../src/cli/ensure.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { CRONITOR_URL } from "../src/cli/heartbeat.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { fakeX1Validator, HOME } from "./helpers/fake-x1-validator.js";

const MINUTE_MS = 60 * 1000;
const PRIVATE = { rpcAddress: "127.0.0.1", flagRunning: true };

/**
 * Reads the fixture start script, as x1console's update leaves it.
 * @returns {string}
 */
function scriptWithoutFlag() {
  return fs.readFileSync(
    fileURLToPath(new URL("fixtures/start_validator.sh", import.meta.url)),
    "utf8",
  );
}

/**
 * Runs ensure.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} [options]  ensure's options.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function ensure(host, settings, options = {}) {
  const run = commandRun(host, settings, {
    options: { quiet: true, fromGitHook: false, ...options },
  });
  const code = await runEnsure(run);
  return { code, lines: run.lines };
}

/**
 * Lists the Telegram messages the fake host was asked to send.
 * @param {object} host  The fake host.
 * @returns {string[]}
 */
function telegramTexts(host) {
  return host.posts
    .filter((post) => post.url.startsWith("https://api.telegram.org/"))
    .map((post) => post.body.text);
}

test("before apply has run, ensure does nothing and exits 0", async () => {
  const { host } = fakeX1Validator();
  const { code, lines } = await ensure(host, {});
  assert.equal(code, 0);
  assert.deepEqual(lines, []);
  assert.deepEqual(host.calls, []);
});

test("puts the flag back after an update, and says so once", async () => {
  const { host, settings, scriptPath } = await appliedValidator(
    { state: PRIVATE },
    {},
  );
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const first = await ensure(host, settings);
  assert.match(
    host.files.get(scriptPath),
    /--rpc-port 8899 --private-rpc \\$/m,
  );
  assert.ok(
    first.lines.some((line) =>
      line.includes(`Put --private-rpc back into ${scriptPath}`),
    ),
  );
  const second = await ensure(host, settings);
  assert.deepEqual(second.lines, []);
});

test("waits out an update in progress, unless git's hook runs it", async () => {
  const {
    host,
    settings: shipped,
    scriptPath,
  } = await appliedValidator({ state: PRIVATE }, {});
  const quietMs = (shipped.startScriptQuietSeconds + 60) * 1000;
  const settings = {
    ...shipped,
    startScriptQuietSeconds: quietMs / 1000,
  };
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(quietMs - 1000);
  const recent = await ensure(host, settings);
  assert.doesNotMatch(host.files.get(scriptPath), /--private-rpc/);
  assert.equal(
    recent.lines.some((line) => line.includes("couldn't put it back")),
    false,
  );
  await host.sleep(1000);
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  host.files.set(path.join(x1consoleDir, ".git", "index.lock"), "");
  await ensure(host, settings);
  assert.doesNotMatch(host.files.get(scriptPath), /--private-rpc/);
  await ensure(host, settings, { fromGitHook: true });
  assert.match(host.files.get(scriptPath), /--private-rpc/);
});

test("when the flag can't go back, the alert says why", async () => {
  const { host, settings, scriptPath } = await appliedValidator(
    { state: PRIVATE, telegram: true },
    {},
  );
  const relaid = scriptWithoutFlag().replace(
    "--rpc-port 8899 \\",
    "--rpc-port=8899 \\",
  );
  host.files.set(scriptPath, relaid);
  const { code } = await ensure(host, settings);
  assert.equal(code, 1);
  const alert = telegramTexts(host).find((text) =>
    text.includes("couldn't put it back"),
  );
  assert.ok(alert.includes("must hold exactly one line of the form"), alert);
});

test("a public rpc alerts once, then again after the reminder interval", async () => {
  const { host, settings: shipped } = await appliedValidator(
    { telegram: true },
    {},
  );
  // Twice the shipped interval, so a repeat at the shipped one would show.
  const reminderMinutes = shipped.exposedReminderMinutes * 2;
  const settings = { ...shipped, exposedReminderMinutes: reminderMinutes };
  await ensure(host, settings);
  const alerts = () =>
    telegramTexts(host).filter((text) => text.includes("The rpc is public"));
  assert.equal(alerts().length, 1);
  assert.match(
    alerts()[0],
    /^x1-validator-private-rpc on x1-rpc\.example\.com: The rpc is public\. The rpc listens on 0\.0\.0\.0:8899 and 0\.0\.0\.0:8900, so anyone can reach it\.$/,
  );
  await host.sleep((reminderMinutes - 1) * MINUTE_MS);
  await ensure(host, settings);
  assert.equal(alerts().length, 1);
  await host.sleep(MINUTE_MS);
  await ensure(host, settings);
  assert.equal(alerts().length, 2);
});

test("the certificate check warns as many days ahead as the settings say", async () => {
  const {
    host,
    state,
    settings: shipped,
  } = await appliedValidator({ state: PRIVATE }, {});
  const settings = {
    ...shipped,
    certificateWarningDays: shipped.certificateWarningDays * 2,
  };
  // Enough days left for the shipped setting, too few for this one.
  state.certificateDays = shipped.certificateWarningDays + 1;
  const { code, lines } = await ensure(host, settings, { quiet: false });
  assert.equal(code, 1);
  assert.ok(
    lines.includes(
      `[ensure] problem: The certificate has ${state.certificateDays} days left.`,
    ),
    lines.join("\n"),
  );
});

test("ensure's requests wait as long as the settings say", async () => {
  const { host, settings: shipped } = await appliedValidator(
    { telegram: true },
    {},
  );
  const settings = {
    ...shipped,
    requestTimeoutSeconds: shipped.requestTimeoutSeconds * 2,
  };
  host.files.set(
    featurePaths().envPath,
    `${CRONITOR_URL}=https://cronitor.link/p/KEY/MONITOR\n`,
  );
  const timeouts = [];
  for (const name of ["httpsGet", "postJson"]) {
    const ask = host[name];
    host[name] = (...args) => {
      timeouts.push({ name, ms: args.at(-1) });
      return ask(...args);
    };
  }
  const tlsGet = host.tlsGet;
  host.tlsGet = (target) => {
    timeouts.push({ name: "tlsGet", ms: target.timeoutMs });
    return tlsGet(target);
  };
  await ensure(host, settings);
  const kinds = new Set(timeouts.map((entry) => entry.name));
  assert.deepEqual([...kinds].sort(), ["httpsGet", "postJson", "tlsGet"]);
  const timeoutMs = settings.requestTimeoutSeconds * 1000;
  assert.ok(
    timeouts.every((entry) => entry.ms === timeoutMs),
    JSON.stringify(timeouts),
  );
});

test("an alert Telegram didn't take goes out at the next run", async () => {
  const { host, state, settings } = await appliedValidator(
    { telegram: true, state: PRIVATE },
    {},
  );
  const postJson = host.postJson;
  let refuse = true;
  host.postJson = (url, body, timeoutMs) =>
    url.startsWith("https://api.telegram.org/") && refuse
      ? Promise.resolve({ status: 502, body: "" })
      : postJson(url, body, timeoutMs);
  state.active = false;
  const first = await ensure(host, settings);
  assert.ok(
    first.lines.some((line) => line.includes("It goes at the next run.")),
  );
  const pending = JSON.parse(
    host.files.get(featurePaths().alertStatePath),
  ).pending;
  assert.equal(pending.length, 1);
  refuse = false;
  await ensure(host, settings);
  assert.ok(telegramTexts(host).some((text) => text.includes("nginx is down")));
  assert.deepEqual(
    JSON.parse(host.files.get(featurePaths().alertStatePath)).pending,
    [],
  );
});

test("a damaged alert state, a check without its last alert time, is set aside for a fresh one", async () => {
  const { host, settings } = await appliedValidator(
    { telegram: true, state: PRIVATE },
    {},
  );
  const { alertStatePath } = featurePaths();
  const damaged = {
    version: 1,
    checks: { gate: { bad: true, lastAlertAt: null } },
    pending: ["a message from the damaged file"],
  };
  host.files.set(alertStatePath, JSON.stringify(damaged));
  await ensure(host, settings);
  const texts = telegramTexts(host);
  assert.equal(
    texts.some((text) => text.includes("a message from the damaged file")),
    false,
  );
  const kept = JSON.parse(host.files.get(alertStatePath));
  assert.deepEqual(kept.checks.gate, {
    bad: false,
    lastAlertAt: NEVER_ALERTED,
  });
});

test("checks in with Cronitor when .env holds its url", async () => {
  const { host, settings } = await appliedValidator({ state: PRIVATE }, {});
  host.files.set(
    featurePaths().envPath,
    `${CRONITOR_URL}=https://cronitor.link/p/KEY/MONITOR\n`,
  );
  const fetched = [];
  const httpsGet = host.httpsGet;
  host.httpsGet = (url, timeoutMs) => {
    fetched.push(url);
    return httpsGet(url, timeoutMs);
  };
  await ensure(host, settings);
  assert.deepEqual(fetched, [
    "https://cronitor.link/p/KEY/MONITOR?state=complete",
  ]);
});

test("without --quiet, it reports every check; with it, nothing when all is well", async () => {
  const { host, settings } = await appliedValidator({ state: PRIVATE }, {});
  const quiet = await ensure(host, settings);
  assert.deepEqual(quiet.lines, []);
  assert.equal(quiet.code, 0);
  const loud = await ensure(host, settings, { quiet: false });
  assert.equal(loud.lines.length, 8);
  assert.ok(
    loud.lines.every((line) => line.startsWith("[ensure] ok: ")),
    loud.lines.join("\n"),
  );
});
