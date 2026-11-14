/**
 * @file x1-validator-private-rpc/test/apply-hand-over.test.js
 * @description
 * Tests apply's hand-over, on a fake validator. It says to restart the
 * validator while the running one lacks the flag, even on a run that
 * finds the flag already in the start script after an earlier run
 * stopped short. It says nothing about a restart once the running
 * validator carries the flag.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { RESTART_HOW } from "../src/cli/start-script.js";
import { loadSettings } from "../src/lib/settings.js";
import { commandRun, PASSWORD } from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs apply on a fake validator.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} prompts  The answers.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function apply(host, settings, prompts) {
  const run = commandRun(host, settings, {
    prompts,
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  const code = await runApply(run);
  return { code, lines: run.lines };
}

/**
 * Builds a fake validator, and the settings apply runs with there.
 * @param {object} [state]  Changes to the fake's starting state.
 * @returns {{host: object, settings: object}}
 */
function freshValidator(state = {}) {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host } = fakeX1Validator({ settings, state });
  return { host, settings };
}

/**
 * Tells whether apply's output says to restart the validator.
 * @param {string[]} lines  apply's output.
 * @returns {boolean}
 */
function saysRestart(lines) {
  return lines.some((line) => line.endsWith(RESTART_HOW));
}

test("after a run that stopped short, the next one still says to restart, since the running validator lacks the flag", async () => {
  const { host, settings } = freshValidator();
  const stopped = await apply(
    host,
    settings,
    scriptedPrompts({
      passwords: [PASSWORD, PASSWORD],
      confirm: (question) => !question.startsWith("Stage 7 of 8"),
    }),
  );
  assert.equal(stopped.code, 1);
  assert.equal(saysRestart(stopped.lines), false);
  const finished = await apply(
    host,
    settings,
    scriptedPrompts({ passwords: [PASSWORD] }),
  );
  assert.equal(finished.code, 0, finished.lines.join("\n"));
  assert.ok(
    finished.lines.includes(
      "[start script] The validator's command carries --private-rpc already.",
    ),
  );
  assert.ok(saysRestart(finished.lines), finished.lines.join("\n"));
});

test("once the running validator carries the flag, apply says nothing about a restart", async () => {
  const { host, settings } = freshValidator({ flagRunning: true });
  const { code, lines } = await apply(
    host,
    settings,
    scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(saysRestart(lines), false);
});
