/**
 * @file x1-validator-private-rpc/test/turn-private-rpc.test.js
 * @description
 * Tests turn-off-private-rpc and turn-on-private-rpc on a fake validator
 * that apply set up:
 *
 * - off takes the flag out after asking, and ensure then leaves it out,
 *   once startScriptQuietSeconds has passed and when the git hook runs
 *   it, and stops checking that the rpc is private, but still alerts
 *   when nginx is down or its certificate needs attention
 * - off, and undo-apply once it has taken the flag out, say what the
 *   validator's next start changes, unless the running validator lacks
 *   the flag already
 * - off leaves a flag on a line of its own, which the tool didn't add,
 *   and says so, with no restart line
 * - off takes out a flag that ensure put back while its question waited,
 *   and keeps an update's change made meanwhile, and refuses while
 *   another command holds the start script's lock
 * - with every setting changed, both edit the start script where the
 *   settings put it
 * - on puts the flag back, for ensure to keep there again
 * - a no stops off
 * - each says so when there's nothing to change
 * - apply turns private rpc on again
 * - before apply has added the flag, ensure leaves the start script
 *   alone, until turn-on turns private rpc on, and so it does in a
 *   reinstall after an undo-apply that left nginx installed
 * - undo-apply leaves a flag turn-on added before apply's flag stage, and
 *   says so
 * - neither runs before apply
 * - ensure asks nothing and uses no sudo, with private rpc on or off
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { runEnsure } from "../src/cli/ensure.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import {
  flagStaysNote,
  RESTART_HOW,
  RPC_KEPT_UNTIL_RESTART,
} from "../src/cli/start-script.js";
import {
  lockStartScript,
  readState,
  START_SCRIPT_LOCKED,
} from "../src/cli/state.js";
import {
  runTurnOffPrivateRpc,
  runTurnOnPrivateRpc,
} from "../src/cli/turn-private-rpc.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
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
 * Each way a command that takes the flag out can find the running
 * validator, as the fake's starting state, and whether the command then
 * says what a restart changes: while the validator carries the flag, and
 * while nothing listens on the rpc port, since it may be starting, but
 * not while it lacks the flag already.
 */
const RUNNING_VALIDATORS = [
  { found: "carries the flag", state: PRIVATE, restartSaid: true },
  { found: "lacks the flag", state: {}, restartSaid: false },
  {
    found: "isn't on the rpc port",
    state: { validatorRunning: false },
    restartSaid: true,
  },
];

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

test("turn-off takes the flag out after asking, and ensure leaves it out, but still alerts on nginx and its certificate", async () => {
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
  // Clients still use the keyed url, so nginx and its certificate alert.
  state.certificateDays = settings.certificateWarningDays - 1;
  assert.equal((await ensure(host, settings)).code, 1);
  state.active = false;
  assert.equal((await ensure(host, settings)).code, 1);
  const alerts = host.posts
    .filter((post) => post.url.startsWith("https://api.telegram.org/"))
    .map((post) => post.body.text);
  const titles = [
    "The certificate needs attention",
    "nginx is down",
    "The rpc is public",
  ];
  assert.deepEqual(
    titles.map((title) => alerts.some((text) => text.includes(title))),
    [true, true, false],
  );
});

test("turn-off says what the validator's next start changes, unless the running validator lacks the flag already", async () => {
  for (const { found, state, restartSaid } of RUNNING_VALIDATORS) {
    const { host, settings } = await appliedValidator({ state });
    const off = await turn(runTurnOffPrivateRpc, host, settings);
    assert.equal(off.code, 0, off.lines.join("\n"));
    const said = off.lines.includes(
      `[turn-off-private-rpc] ${RPC_KEPT_UNTIL_RESTART}`,
    );
    assert.equal(said, restartSaid, `The running validator ${found}.`);
  }
});

test("turn-off leaves a flag on a line of its own, which it didn't add, and says so, with no restart line", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host, scriptPath } = fakeX1Validator({ settings, state: PRIVATE });
  // Added by hand before apply, on a line of its own like the other flags.
  const handEdited = host.files
    .get(scriptPath)
    .replace(/^( *)(--rpc-port 8899 \\)$/m, "$1$2\n$1--private-rpc \\");
  host.files.set(scriptPath, handEdited);
  const applied = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(applied), 0, applied.lines.join("\n"));
  assert.equal(host.files.get(scriptPath), handEdited);
  const off = await turn(runTurnOffPrivateRpc, host, settings);
  assert.equal(off.code, 0, off.lines.join("\n"));
  const note = flagStaysNote(scriptPath, "the tool");
  assert.deepEqual(off.lines, [
    `[turn-off-private-rpc] Private rpc is off, but ${note}`,
  ]);
  assert.equal(host.files.get(scriptPath), handEdited);
  assert.equal(choice(host), "off");
});

test("once it has taken the flag out, undo-apply says what the validator's next start changes, unless the running validator lacks the flag already", async () => {
  for (const { found, state, restartSaid } of RUNNING_VALIDATORS) {
    const { host, settings } = await appliedValidator({ state });
    const undo = commandRun(host, settings, {
      prompts: scriptedPrompts({ ask: () => true }),
    });
    assert.equal(await runUndoApply(undo), 0, undo.lines.join("\n"));
    const flagOut = undo.lines.findIndex((line) =>
      line.startsWith("[undo-apply] Done: take --private-rpc out of"),
    );
    assert.ok(flagOut >= 0, undo.lines.join("\n"));
    const restart = undo.lines.indexOf(
      `[undo-apply] ${RPC_KEPT_UNTIL_RESTART}`,
    );
    assert.equal(
      restart,
      restartSaid === true ? flagOut + 1 : -1,
      `The running validator ${found}.`,
    );
  }
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
  const before = "--maximum-full-snapshots-to-retain 50";
  const after = "--maximum-full-snapshots-to-retain 25";
  assert.ok(original.includes(before));
  // An Update X1 Console took the flag out, and brought no new commits.
  host.files.set(scriptPath, original);
  host.modified.set(scriptPath, host.now());
  await host.sleep(settings.startScriptQuietSeconds * 1000);
  const off = await turn(runTurnOffPrivateRpc, host, settings, async () => {
    /*-
     * While the question waits, an update changes another line, and its
     * git hook's ensure puts the flag back.
     */
    host.files.set(scriptPath, original.replace(before, after));
    host.modified.set(scriptPath, host.now());
    await ensure(host, settings, { fromGitHook: true });
    assert.match(host.files.get(scriptPath), FLAG);
    return true;
  });
  assert.equal(off.code, 0, off.lines.join("\n"));
  // Only the flag comes out: the update's change stays.
  assert.equal(host.files.get(scriptPath), original.replace(before, after));
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

test("after an undo-apply that left nginx installed, a later apply stopped before its flag stage keeps ensure off the start script", async () => {
  const { host, settings, scriptPath } = await appliedValidator({
    telegram: true,
  });
  const undo = commandRun(host, settings, {
    prompts: scriptedPrompts({ ask: () => true }),
  });
  assert.equal(await runUndoApply(undo), 0, undo.lines.join("\n"));
  const unflagged = host.files.get(scriptPath);
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
  assert.equal(host.files.get(scriptPath), unflagged);
});

test("undo-apply leaves a flag turn-on added before apply's flag stage, and says so", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host, scriptPath } = fakeX1Validator({ settings });
  const stopped = commandRun(host, settings, {
    prompts: scriptedPrompts({
      confirm: (question) => !question.startsWith("Stage 6 of 8"),
      passwords: [PASSWORD, PASSWORD],
    }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(stopped), 1, stopped.lines.join("\n"));
  const on = await turn(runTurnOnPrivateRpc, host, settings);
  assert.equal(on.code, 0, on.lines.join("\n"));
  // The rerun finishes, and records the flag at its stage as found.
  const again = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  const undo = commandRun(host, settings, {
    prompts: scriptedPrompts({ ask: () => true }),
  });
  assert.equal(await runUndoApply(undo), 0, undo.lines.join("\n"));
  assert.match(host.files.get(scriptPath), FLAG);
  const note = flagStaysNote(scriptPath, "apply");
  const said = undo.lines.includes(`[undo-apply] ${note}`);
  assert.ok(said, undo.lines.join("\n"));
});

test("neither runs before apply", async () => {
  const { host } = fakeX1Validator();
  for (const command of [runTurnOffPrivateRpc, runTurnOnPrivateRpc]) {
    await assert.rejects(turn(command, host, {}), {
      message: "apply hasn't set nginx up yet. Run apply first.",
    });
  }
});
