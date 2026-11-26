/**
 * @file x1-validator-private-rpc/test/apply-hand-over.test.js
 * @description
 * Tests apply's hand-over, on a fake validator. It says to restart the
 * validator while the running one lacks the flag, even on a run that
 * finds the flag already in the start script after an earlier run
 * stopped short. It says nothing about a restart once the running
 * validator carries the flag. A dry run says the restart a real run
 * would need, and not to restart now. Its last line gives the command
 * that makes more api keys, through nvm on the Node.js the tool needs,
 * since a validator's default node is older. A test alert that Telegram
 * refuses doesn't stop apply before the hand-over: apply then ends with
 * what to check, and exit code 1.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { RESTART_HOW, RESTART_STEPS } from "../src/cli/start-script.js";
import { TOKEN_FILE } from "../src/cli/telegram.js";
import { oldestNode } from "../src/lib/node-version.js";
import { loadSettings } from "../src/lib/settings.js";
import { commandRun, PASSWORD } from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import {
  fakeX1Validator,
  HOME,
  HOSTNAME,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs apply on a fake validator.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} prompts  The answers.
 * @param {boolean} [dryRun]  Whether it's a dry run.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function apply(host, settings, prompts, dryRun = false) {
  const run = commandRun(host, settings, {
    prompts,
    options: { yes: false, dryRun, acmeStaging: false },
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

test("once the running validator carries the flag, apply says nothing about a restart, and ends with the command for more keys", async () => {
  const { host, settings } = freshValidator({ flagRunning: true });
  const { code, lines } = await apply(
    host,
    settings,
    scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(saysRestart(lines), false);
  assert.equal(
    lines.at(-1),
    `[hand-over] To make more api keys, run: nvm exec ${oldestNode().major} node ${featurePaths().toolCli} add-api-key`,
  );
});

test("a test alert Telegram refuses doesn't stop apply: the hand-over follows, then what to check, with exit code 1", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host } = fakeX1Validator({ settings, telegram: true });
  const postJson = host.postJson;
  host.postJson = (url, body, timeoutMs) =>
    url.startsWith("https://api.telegram.org/")
      ? Promise.resolve({ status: 401, body: "" })
      : postJson(url, body, timeoutMs);
  const { code, lines } = await apply(
    host,
    settings,
    scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
  );
  assert.equal(code, 1, lines.join("\n"));
  assert.ok(
    lines.includes(
      "[watchers] The test alert failed: Telegram answered http 401.",
    ),
    lines.join("\n"),
  );
  assert.ok(saysRestart(lines), lines.join("\n"));
  assert.ok(
    lines.some((line) => line.startsWith("[hand-over] The rpc's url: ")),
  );
  const tokenPath = path.join(
    homePath(settings.x1consoleDir, HOME),
    TOKEN_FILE,
  );
  assert.match(lines.at(-1), /^\[apply\] Every stage ran, but the test alert/);
  assert.ok(lines.at(-1).includes(tokenPath), lines.at(-1));
});

test("a dry run says the restart a real run would need, and not to restart now", async () => {
  const { host, settings } = freshValidator();
  const { code, lines } = await apply(host, settings, scriptedPrompts(), true);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(saysRestart(lines), false);
  assert.ok(
    lines.includes(
      `[hand-over] The running validator lacks --private-rpc. Since this is a dry run, you will not restart it from x1console, but in a real run, you would restart it: ${RESTART_STEPS}`,
    ),
    lines.join("\n"),
  );
});
