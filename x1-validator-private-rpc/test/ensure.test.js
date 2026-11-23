/**
 * @file x1-validator-private-rpc/test/ensure.test.js
 * @description
 * Tests ensure on a fake validator that apply set up:
 *
 * - nothing before apply
 * - the flag put back after an update, with one notice and one alert
 * - a run skipped while another command holds the start script's lock
 * - an update waited out, for as long as the settings say, while git
 *   holds its lock in the checkout they name, and while git works there,
 *   as through a slow fetch, unless the git hook runs ensure
 * - the reason the flag couldn't go back, in the alert, and no alert that
 *   it's back
 * - a public rpc's alert and its repeats, as often as the settings say
 * - the certificate's warning, as many days ahead as they say, and its
 *   alert's repeats, as often as they say
 * - requests that wait as long as they say
 * - an alert Telegram didn't take, sent at the next run
 * - a damaged alert state, set aside for a fresh one
 * - the Cronitor check-in, tried as many times as the settings say, and
 *   what --quiet prints
 * - every check passing with every setting changed, and an alert sent
 *   through the Telegram files in the folder they name for x1console
 * - in every run, no question and no sudo, and the hostname apply set
 *   nginx up with, whatever the settings name now
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FLAG_RESTORED, NEVER_ALERTED } from "../src/cli/alerts.js";
import { runEnsure } from "../src/cli/ensure.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { CRONITOR_URL } from "../src/cli/heartbeat.js";
import { lockStartScript, START_SCRIPT_LOCKED } from "../src/cli/state.js";
import { GATE_PAGE_NAME } from "../src/lib/gate-page.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { sudoCalls } from "./helpers/fake-host.js";
import {
  ANOTHER_HOSTNAME,
  fakeX1Validator,
  HOME,
  HOSTNAME,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

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
 * Runs ensure, and checks that it asked nothing and used no sudo, since
 * cron runs it with nobody at the terminal. The settings name another
 * hostname than apply set nginx up with, since ensure checks what nginx
 * serves.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} [options]  ensure's options.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function ensure(host, settings, options = {}) {
  const from = host.calls.length;
  const later = { ...settings, hostname: ANOTHER_HOSTNAME };
  const prompts = scriptedPrompts();
  const run = commandRun(host, later, {
    prompts,
    options: { quiet: true, fromGitHook: false, ...options },
  });
  const code = await runEnsure(run);
  const rooted = sudoCalls(host.calls.slice(from));
  assert.deepEqual([prompts.asked, rooted], [[], []]);
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
    { state: PRIVATE, telegram: true },
    {},
  );
  const restored = () =>
    telegramTexts(host).filter((text) => text.endsWith(FLAG_RESTORED));
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const first = await ensure(host, settings);
  assert.match(
    host.files.get(scriptPath),
    /--rpc-port 8899 --private-rpc \\$/m,
  );
  assert.equal(host.fileMode(scriptPath), 0o755);
  assert.ok(
    first.lines.some((line) =>
      line.includes(`Put --private-rpc back into ${scriptPath}`),
    ),
  );
  assert.equal(restored().length, 1);
  const second = await ensure(host, settings);
  assert.deepEqual(second.lines, []);
  assert.equal(restored().length, 1);
});

test("skips its run while another command holds the start script's lock, and the next run puts the flag back", async () => {
  const { host, settings, scriptPath } = await appliedValidator(
    { state: PRIVATE },
    {},
  );
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const release = lockStartScript(host, featurePaths().statePath);
  const skipped = await ensure(host, settings, { quiet: false });
  release();
  assert.deepEqual(skipped, {
    code: 0,
    lines: [`[ensure] ${START_SCRIPT_LOCKED}`],
  });
  assert.equal(host.files.get(scriptPath), scriptWithoutFlag());
  await ensure(host, settings);
  assert.match(
    host.files.get(scriptPath),
    /--rpc-port 8899 --private-rpc \\$/m,
  );
});

test("waits out an update in progress, unless the tool's git hook runs it", async () => {
  /*-
   * Every setting changed, so git's lock counts only in the x1console
   * checkout the settings name.
   */
  const { changed } = shippedAndChangedSettings();
  const {
    host,
    settings: applied,
    scriptPath,
  } = await appliedValidator(
    { state: PRIVATE, settings: { ...changed, hostname: HOSTNAME } },
    {},
  );
  const quietMs = (applied.startScriptQuietSeconds + 60) * 1000;
  const settings = {
    ...applied,
    startScriptQuietSeconds: quietMs / 1000,
  };
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(quietMs - 1000);
  const recent = await ensure(host, settings, { quiet: false });
  assert.doesNotMatch(host.files.get(scriptPath), /--private-rpc/);
  assert.equal(
    recent.lines.some((line) => line.includes("couldn't put it back")),
    false,
  );
  // A run by hand says when to run it again, for a machine without cron.
  assert.ok(
    recent.lines.some((line) =>
      line.endsWith(`gone unchanged for ${quietMs / 1000} seconds.`),
    ),
    recent.lines.join("\n"),
  );
  await host.sleep(1000);
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  host.files.set(path.join(x1consoleDir, ".git", "index.lock"), "");
  await ensure(host, settings);
  assert.doesNotMatch(host.files.get(scriptPath), /--private-rpc/);
  await ensure(host, settings, { fromGitHook: true });
  assert.match(host.files.get(scriptPath), /--private-rpc/);
});

test("waits while git works in x1console's folder, as through a slow fetch, unless the tool's git hook runs it", async () => {
  // Every setting changed, so only git in the configured checkout counts.
  const { changed } = shippedAndChangedSettings();
  const { host, settings, scriptPath } = await appliedValidator(
    { state: PRIVATE, settings: { ...changed, hostname: HOSTNAME } },
    {},
  );
  const quietMs = settings.startScriptQuietSeconds * 1000;
  // The stash changed the script long ago, and git holds no lock: only
  // the pull's fetch is still at work.
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now());
  await host.sleep(quietMs + 60000);
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  host.programs.set(x1consoleDir, ["bash", "git", "git-remote-http"]);
  const fetching = await ensure(host, settings, { quiet: false });
  assert.doesNotMatch(host.files.get(scriptPath), /--private-rpc/);
  assert.ok(
    fetching.lines.some((line) => line.includes("x1console may be updating")),
    fetching.lines.join("\n"),
  );
  await ensure(host, settings, { fromGitHook: true });
  assert.match(host.files.get(scriptPath), /--private-rpc/);
  // Another program that works there holds nothing off.
  host.files.set(scriptPath, scriptWithoutFlag());
  host.modified.set(scriptPath, host.now() - quietMs - 60000);
  host.programs.set(x1consoleDir, ["bash"]);
  await ensure(host, settings);
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
  assert.equal(
    telegramTexts(host).some((text) => text.endsWith(FLAG_RESTORED)),
    false,
  );
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

test("the certificate's alert repeats as often as the settings say", async () => {
  const {
    host,
    state,
    settings: shipped,
  } = await appliedValidator({ state: PRIVATE, telegram: true });
  // Twice the shipped interval, so a repeat at the shipped one would show.
  const hours = shipped.certificateReminderHours * 2;
  const settings = { ...shipped, certificateReminderHours: hours };
  state.certificateDays = shipped.certificateWarningDays - 1;
  const alerts = () =>
    telegramTexts(host).filter((text) =>
      text.includes("The certificate needs attention"),
    );
  await ensure(host, settings);
  assert.equal(alerts().length, 1);
  await host.sleep(hours * 60 * MINUTE_MS - MINUTE_MS);
  await ensure(host, settings);
  assert.equal(alerts().length, 1);
  await host.sleep(MINUTE_MS);
  await ensure(host, settings);
  assert.equal(alerts().length, 2);
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
    url.startsWith("https://api.telegram.org/") && refuse === true
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
    checks: { certificate: { bad: true, lastAlertAt: null } },
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
  assert.deepEqual(kept.checks.certificate, {
    bad: false,
    lastAlertAt: NEVER_ALERTED,
  });
});

test("checks in with Cronitor when .env holds its url, and tries as many times as the settings say", async () => {
  const { host, settings: shipped } = await appliedValidator(
    { state: PRIVATE },
    {},
  );
  // A changed count, so code that kept the shipped one would show.
  const tries = shippedAndChangedSettings().changed.cronitorCheckInTries;
  const settings = { ...shipped, cronitorCheckInTries: tries };
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
  fetched.length = 0;
  host.httpsGet = async (url) => {
    fetched.push(url);
    return { status: 500, body: "" };
  };
  await ensure(host, settings);
  assert.equal(fetched.length, tries);
});

test("with every setting changed, it reports every check without --quiet, nothing with it when all is well, and an alert through the Telegram files in the folder x1consoleDir names", async () => {
  /*-
   * Every setting changed, so a check that read a shipped value, such as
   * x1console's start script's place, or the folder of x1console's
   * Telegram files, would show.
   */
  const { changed } = shippedAndChangedSettings();
  const { host, state, settings } = await appliedValidator({
    state: PRIVATE,
    telegram: true,
    settings: { ...changed, hostname: HOSTNAME },
  });
  const quiet = await ensure(host, settings);
  assert.deepEqual(quiet.lines, []);
  assert.equal(quiet.code, 0);
  const loud = await ensure(host, settings, { quiet: false });
  assert.equal(loud.lines.length, 7);
  assert.ok(
    loud.lines.every((line) => line.startsWith("[ensure] ok: ")),
    loud.lines.join("\n"),
  );
  assert.ok(loud.lines.includes(`[ensure] ok: ${GATE_PAGE_NAME} says ok.`));
  state.active = false;
  await ensure(host, settings);
  assert.ok(telegramTexts(host).some((text) => text.includes("nginx is down")));
});
