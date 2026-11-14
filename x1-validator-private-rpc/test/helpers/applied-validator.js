/**
 * @file x1-validator-private-rpc/test/helpers/applied-validator.js
 * @description
 * A fake x1console validator that apply has already set up, for the
 * tests of the commands that come after it: ensure, undo-apply, unlock
 * and url. It also makes the run those commands take, with a log whose
 * lines the test can read.
 */

import { runApply } from "../../src/cli/apply.js";
import { featurePaths } from "../../src/cli/feature-paths.js";
import { createLog } from "../../src/cli/log.js";
import { loadSettings } from "../../src/lib/settings.js";
import { copyShippedConfig } from "./config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./fake-x1-validator.js";
import { scriptedPrompts } from "./scripted-prompts.js";

export const PASSWORD = "a long test password";

/**
 * Makes a run for a command, with a log the test can read.
 * @param {object} host  The fake host.
 * @param {object} settings  The tool's settings.
 * @param {object} [more]  More of the run: prompts and options.
 * @returns {object} The run, with `lines` holding what the log printed.
 */
export function commandRun(host, settings, more = {}) {
  const lines = [];
  return {
    host,
    settings,
    overridePath: "/operator/private-rpc.json",
    paths: featurePaths(),
    log: createLog({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    }),
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
    options: {},
    lines,
    ...more,
  };
}

/**
 * Builds a fake validator and runs apply on it.
 * @param {object} [scenario]  The fake validator's scenario. Its settings
 *   default to the shipped ones, with the test's hostname.
 * @param {{savePassword?: boolean, acmeStaging?: boolean}} [choices]
 *   apply's answers, and whether it runs with --acme-staging.
 * @returns {Promise<{host: object, state: object, settings: object,
 *   scriptPath: string}>}
 * @throws {Error} When apply doesn't finish, with its log.
 */
export async function appliedValidator(scenario = {}, choices = {}) {
  const settings =
    scenario.settings ??
    loadSettings(
      copyShippedConfig(JSON.stringify({ hostname: HOSTNAME })).configDir,
    );
  const { host, state, scriptPath } = fakeX1Validator({
    ...scenario,
    settings,
  });
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({
      ask: () => choices.savePassword === true,
      passwords: [PASSWORD, PASSWORD],
    }),
    options: {
      yes: false,
      dryRun: false,
      acmeStaging: choices.acmeStaging === true,
    },
  });
  const code = await runApply(run);
  if (code !== 0) {
    throw new Error(`apply failed:\n${run.lines.join("\n")}`);
  }
  return { host, state, settings, scriptPath };
}
