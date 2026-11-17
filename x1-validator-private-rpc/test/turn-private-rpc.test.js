/**
 * @file x1-validator-private-rpc/test/turn-private-rpc.test.js
 * @description
 * Tests turn-off-private-rpc and turn-on-private-rpc on a fake validator
 * that apply set up:
 *
 * - off takes the flag out after asking, and ensure then leaves it out,
 *   once startScriptQuietSeconds has passed and when the git hook runs
 *   it, and stops checking that the rpc is private
 * - off takes out a flag that ensure put back while its question waited,
 *   and refuses while another command holds the start script's lock
 * - with every setting changed, both edit the start script where the
 *   settings put it
 * - on puts the flag back, for ensure to keep there again
 * - a no stops off
 * - each says so when there's nothing to change
 * - apply turns private rpc on again
 * - before apply has added the flag, ensure leaves the start script
 *   alone, until turn-on turns private rpc on
 * - neither runs before apply
 * - ensure asks nothing and uses no sudo, with private rpc on or off
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { runEnsure } from "../src/cli/ensure.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import { RESTART_HOW } from "../src/cli/start-script.js";
import {
  lockStartScript,
  readState,
  START_SCRIPT_LOCKED,
} from "../src/cli/state.js";
import {
  runTurnOffPrivateRpc,
  runTurnOnPrivateRpc,
} from "../src/cli/turn-private-rpc.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
} from "./helpers/applied-validator.js";
import {
  copyShippedConfig,
  shippedAndChangedSettings,
} from "./helpers/config-copies.js";
import { sudoCalls } from "./helpers/fake-host.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const FLAG = /--rpc-port 8899 --private-rpc \\$/m;
const PRIVATE = { rpcAddress: "127.0.0.1", flagRunning: true };

/**
 * Runs one of the two commands.
 * @param {(run: object) => Promise<number>} command  The command.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {() => boolean|Promise<boolean>} [confirm]  Answers the
 *   confirmation, with yes unless given.
 * @returns {Promise<{code: number, lines: string[], asked: string[]}>}
 */
async function turn(command, host, settings, confirm = () => true) {
  const prompts = scriptedPrompts({ confirm });
  const run = commandRun(host, settings, { prompts });
  const code = await command(run);
  return { code, lines: run.lines, asked: prompts.asked };
}

/**
 * Runs ensure, printing every check, and checks that it asked nothing and
 * used no sudo, since cron runs it with nobody at the terminal.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} [options]  ensure's options.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function ensure(host, settings, options = {}) {
  const from = host.calls.length;
  const prompts = scriptedPrompts();
  const run = commandRun(host, settings, {
    prompts,
    options: { quiet: false, fromGitHook: false, ...options },
  });
  const code = await runEnsure(run);
  const rooted = sudoCalls(host.calls.slice(from));
  assert.deepEqual([prompts.asked, rooted], [[], []]);
  return { code, lines: run.lines };
}

/**
 * Reads the operator's choice from the tool's state.
 * @param {object} host  The fake host.
 * @returns {string}
 */
function choice(host) {
  return readState(host, featurePaths().statePath).privateRpc;
}

/**
 * Makes the fake validator restart without the flag: its rpc listens on
 * every interface, and its command lacks the flag.
 * @param {object} host  The fake host.
 * @param {object} state  The fake machine's state.
 */
function restartPublic(host, state) {
  state.rpcAddress = "0.0.0.0";
  host.files.set(
    "/proc/4242/cmdline",
    ["tachyon-validator", "--rpc-port", "8899"].join("\0"),
  );
}

test("turn-off takes the flag out after asking, and ensure leaves it out", async () => {
  const { host, state, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
    telegram: true,
  });
  const off = await turn(runTurnOffPrivateRpc, host, settings);
  assert.equal(off.code, 0, off.lines.join("\n"));
  assert.equal(off.asked.length, 1);
  assert.match(off.asked[0], /Turn off private rpc\?$/);
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  assert.equal(choice(host), "off");
  assert.ok(off.lines.at(-1).endsWith(RESTART_HOW));
  restartPublic(host, state);
  // Past the wait after a change, so only the choice keeps the flag out.
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const checked = await ensure(host, settings);
  assert.equal(checked.code, 0, checked.lines.join("\n"));
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  assert.ok(checked.lines.some((line) => line.includes("Private rpc is off")));
  const fromHook = await ensure(host, settings, { fromGitHook: true });
  assert.equal(fromHook.code, 0, fromHook.lines.join("\n"));
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  const alerts = host.posts.filter((post) =>
    post.url.startsWith("https://api.telegram.org/"),
  );
  assert.equal(
    alerts.some((post) => post.body.text.includes("The rpc is public")),
    false,
  );
});

test("with every setting changed, turn-off and turn-on edit the start script where the settings put it", async () => {
  const { changed } = shippedAndChangedSettings();
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
    settings: { ...changed, hostname: HOSTNAME },
  });
  const off = await turn(runTurnOffPrivateRpc, host, settings);
  assert.equal(off.code, 0, off.lines.join("\n"));
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  const on = await turn(runTurnOnPrivateRpc, host, settings);
  assert.equal(on.code, 0, on.lines.join("\n"));
  assert.match(host.files.get(scriptPath), FLAG);
});

test("turn-on puts the flag back, for ensure to keep there again", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  const original = fs.readFileSync(
    new URL("fixtures/start_validator.sh", import.meta.url),
    "utf8",
  );
  await turn(runTurnOffPrivateRpc, host, settings);
  const on = await turn(runTurnOnPrivateRpc, host, settings);
  assert.equal(on.code, 0);
  assert.deepEqual(on.asked, []);
  assert.match(host.files.get(scriptPath), FLAG);
  assert.equal(host.fileMode(scriptPath), 0o755);
  assert.equal(choice(host), "on");
  assert.ok(on.lines.at(-1).endsWith(RESTART_HOW));
  host.files.set(scriptPath, original);
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  await ensure(host, settings);
  assert.match(host.files.get(scriptPath), FLAG);
});

test("turn-off takes out a flag that ensure put back while its question waited", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  const original = fs.readFileSync(
    new URL("fixtures/start_validator.sh", import.meta.url),
    "utf8",
  );
  // An Update X1 Console took the flag out, and brought no new commits.
  host.files.set(scriptPath, original);
  host.modified.set(scriptPath, host.now());
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const off = await turn(runTurnOffPrivateRpc, host, settings, async () => {
    // cron's ensure runs while the question waits.
    await ensure(host, settings);
    assert.match(host.files.get(scriptPath), FLAG);
    return true;
  });
  assert.equal(off.code, 0, off.lines.join("\n"));
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  assert.equal(choice(host), "off");
});

test("turn-off refuses while another command holds the start script's lock, and changes nothing", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  const release = lockStartScript(host, featurePaths().statePath);
  await assert.rejects(turn(runTurnOffPrivateRpc, host, settings), {
    message: START_SCRIPT_LOCKED,
  });
  release();
  assert.match(host.files.get(scriptPath), FLAG);
  assert.equal(choice(host), "on");
});

test("a no stops turn-off, and nothing changes", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  const off = await turn(runTurnOffPrivateRpc, host, settings, () => false);
  assert.equal(off.code, 1);
  assert.match(host.files.get(scriptPath), FLAG);
  assert.equal(choice(host), "on");
});

test("each says so when there's nothing to change", async () => {
  const { host, settings } = await appliedValidator({ state: PRIVATE });
  const on = await turn(runTurnOnPrivateRpc, host, settings);
  assert.deepEqual(on.lines, [
    "[turn-on-private-rpc] Private rpc is on: the start script carries --private-rpc.",
  ]);
  await turn(runTurnOffPrivateRpc, host, settings);
  const again = await turn(runTurnOffPrivateRpc, host, settings);
  assert.equal(again.code, 0);
  assert.deepEqual(again.asked, []);
  assert.deepEqual(again.lines, [
    "[turn-off-private-rpc] Private rpc is off already.",
  ]);
});

test("apply turns private rpc on again", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  await turn(runTurnOffPrivateRpc, host, settings);
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  assert.match(host.files.get(scriptPath), FLAG);
  assert.equal(choice(host), "on");
});

test("before apply has added the flag, ensure leaves the start script alone, until turn-on turns private rpc on", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host, scriptPath } = fakeX1Validator({ settings, telegram: true });
  const original = host.files.get(scriptPath);
  const stopped = commandRun(host, settings, {
    prompts: scriptedPrompts({
      confirm: (question) => !question.startsWith("Stage 6 of 8"),
      passwords: [PASSWORD, PASSWORD],
    }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(stopped), 1, stopped.lines.join("\n"));
  assert.equal(choice(host), "");
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const checked = await ensure(host, settings);
  assert.equal(checked.code, 0, checked.lines.join("\n"));
  assert.equal(host.files.get(scriptPath), original);
  assert.ok(
    checked.lines.includes(
      "[ensure] apply hasn't added --private-rpc yet, so ensure leaves the start script alone, and doesn't check that the rpc is private.",
    ),
  );
  const alerts = host.posts.filter((post) =>
    post.url.startsWith("https://api.telegram.org/"),
  );
  assert.deepEqual(alerts, []);
  const on = await turn(runTurnOnPrivateRpc, host, settings);
  assert.equal(on.code, 0, on.lines.join("\n"));
  assert.equal(choice(host), "on");
  host.files.set(scriptPath, original);
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  await ensure(host, settings);
  assert.match(host.files.get(scriptPath), FLAG);
});

test("neither runs before apply", async () => {
  const { host } = fakeX1Validator();
  for (const command of [runTurnOffPrivateRpc, runTurnOnPrivateRpc]) {
    await assert.rejects(turn(command, host, {}), {
      message: "apply hasn't set nginx up yet. Run apply first.",
    });
  }
});
