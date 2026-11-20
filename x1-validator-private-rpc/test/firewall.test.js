/**
 * @file x1-validator-private-rpc/test/firewall.test.js
 * @description
 * Tests apply's firewall stage, and undo-apply's side of it, on a fake
 * validator whose ufw overwrites a rule for the same port, as the real
 * one does. A rule for port 443 that was there before apply stays as the
 * operator made it, through apply and undo-apply, whether ufw is on or
 * off, and whatever the rule's comment, log setting or limit. A rule that
 * closes the port stops apply, in its first stage, or in the firewall
 * stage when it turns up later, and apply never changes it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { HTTPS_RULE } from "../src/cli/apply-install.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
import { NEVER_CHANGED, readRecord } from "../src/cli/what-apply-changed.js";
import { loadSettings } from "../src/lib/settings.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Lists the ufw commands that change rules.
 * @param {object} host  The fake host.
 * @returns {string[]}
 */
function ruleChanges(host) {
  return host.calls
    .filter((call) => call.command === "ufw" && call.args[0] !== "show")
    .map((call) => call.args.join(" "));
}

/**
 * Builds a fake validator holding a firewall rule, and the run that
 * applies to it.
 * @param {string} rule  The rule, as the fake writes it.
 * @param {(state: object) => object} [promptsFor]  Makes the answers,
 *   given the fake's state.
 * @returns {{host: object, state: object, run: object}}
 */
function validatorWithRule(rule, promptsFor = () => scriptedPrompts()) {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host, state } = fakeX1Validator({
    settings,
    state: { ufwRules: ["22/tcp", rule] },
  });
  const run = commandRun(host, settings, {
    prompts: promptsFor(state),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  return { host, state, run };
}

test("an operator's rule for port 443 stays as they made it, through apply and undo-apply, whatever its form", async () => {
  for (const [rule, ufwActive] of [
    [HTTPS_RULE, false],
    [`limit ${HTTPS_RULE}`, true],
    [`allow ${HTTPS_RULE} comment 'https'`, true],
    [`allow log ${HTTPS_RULE}`, false],
  ]) {
    const { host, state, settings } = await appliedValidator({
      state: { ufwActive, ufwRules: ["22/tcp", rule] },
    });
    const record = readRecord(host, featurePaths().whatApplyChangedPath);
    const entry = record.get(`firewallRule:${HTTPS_RULE}`);
    assert.deepEqual(
      [
        entry.applyChangedThisFromItsPreviousValue,
        entry.applyChangedThisValueAtThisTimestampMS,
        entry.oldValue,
      ],
      [false, NEVER_CHANGED, "true"],
      rule,
    );
    const run = commandRun(host, settings, {
      prompts: scriptedPrompts({ ask: () => true }),
    });
    assert.equal(await runUndoApply(run), 0, run.lines.join("\n"));
    assert.deepEqual(state.ufwRules, ["22/tcp", rule]);
    assert.deepEqual(ruleChanges(host), [], rule);
  }
});

test("a rule that closes port 443 stops apply in its first stage, before anything changes", async () => {
  for (const action of ["deny", "reject"]) {
    const rule = `${action} ${HTTPS_RULE}`;
    const { state, run } = validatorWithRule(rule);
    await assert.rejects(runApply(run), (error) =>
      error.message.includes(`ufw's rule "ufw ${rule}" closes tcp port 443`),
    );
    assert.deepEqual(state.ufwRules, ["22/tcp", rule]);
    assert.equal(state.nginxInstalled, false);
  }
});

test("a rule that closes port 443 after the first stage stops the firewall stage, and stays", async () => {
  const deny = `deny ${HTTPS_RULE}`;
  const { host, state, run } = validatorWithRule("8000:10000/tcp", (fake) =>
    scriptedPrompts({
      confirm: (question) => {
        if (question.startsWith("Stage 3 of 8")) {
          fake.ufwRules = ["22/tcp", deny];
        }
        return true;
      },
    }),
  );
  await assert.rejects(runApply(run), (error) =>
    error.message.includes(`ufw's rule "ufw ${deny}" closes`),
  );
  assert.deepEqual(state.ufwRules, ["22/tcp", deny]);
  assert.deepEqual(ruleChanges(host), []);
});
