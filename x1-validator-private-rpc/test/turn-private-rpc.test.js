/**
 * @file x1-validator-private-rpc/test/turn-private-rpc.test.js
 * @description
 * Tests turn-off-private-rpc and turn-on-private-rpc on a fake validator
 * that apply set up:
 *
 * - off takes the flag out after asking, and ensure then leaves it out
 *   and stops checking that the rpc is private
 * - on puts the flag back, for ensure to keep there again
 * - a no stops off
 * - each says so when there's nothing to change
 * - apply turns private rpc on again
 * - before apply has added the flag, ensure leaves the start script
 *   alone, until turn-on turns private rpc on
 * - neither runs before apply
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { runEnsure } from "../src/cli/ensure.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import { RESTART_HOW } from "../src/cli/start-script.js";
import { readState } from "../src/cli/state.js";
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
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const FLAG = /--rpc-port 8899 --private-rpc \\$/m;
const PRIVATE = { rpcAddress: "127.0.0.1", flagRunning: true };

/**
 * Runs one of the two commands.
 * @param {(run: object) => Promise<number>} command  The command.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {boolean} [yes]  The answer to the confirmation.
 * @returns {Promise<{code: number, lines: string[], asked: string[]}>}
 */
async function turn(command, host, settings, yes = true) {
  const prompts = scriptedPrompts({ confirm: () => yes });
  const run = commandRun(host, settings, { prompts });
  const code = await command(run);
  return { code, lines: run.lines, asked: prompts.asked };
}

/**
 * Runs ensure, printing every check.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function ensure(host, settings) {
  const run = commandRun(host, settings, {
    options: { quiet: false, fromGitHook: false },
  });
  const code = await runEnsure(run);
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
  const checked = await ensure(host, settings);
  assert.equal(checked.code, 0, checked.lines.join("\n"));
  assert.doesNotMatch(host.files.get(scriptPath), FLAG);
  assert.ok(checked.lines.some((line) => line.includes("Private rpc is off")));
  const alerts = host.posts.filter((post) =>
    post.url.startsWith("https://api.telegram.org/"),
  );
  assert.equal(
    alerts.some((post) => post.body.text.includes("The rpc is public")),
    false,
  );
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
  assert.equal(choice(host), "on");
  assert.ok(on.lines.at(-1).endsWith(RESTART_HOW));
  host.files.set(scriptPath, original);
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  await ensure(host, settings);
  assert.match(host.files.get(scriptPath), FLAG);
});

test("a no stops turn-off, and nothing changes", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    state: PRIVATE,
  });
  const off = await turn(runTurnOffPrivateRpc, host, settings, false);
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
