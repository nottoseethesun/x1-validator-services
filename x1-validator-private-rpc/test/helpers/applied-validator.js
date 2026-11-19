/**
 * @file x1-validator-private-rpc/test/helpers/applied-validator.js
 * @description
 * A fake x1console validator that apply has already set up, for the
 * tests of the commands that come after it: ensure, undo-apply, url and
 * the api key commands. It also makes the run those commands take, with
 * a log whose lines the test can read, and the lines printed as is,
 * where the new keys' urls go. And it plays the operator's own purge of
 * nginx, which undo-apply leaves to them.
 */

import { runApply } from "../../src/cli/apply.js";
import { featurePaths } from "../../src/cli/feature-paths.js";
import { createLog } from "../../src/cli/log.js";
import { API_KEY_PATTERN } from "../../src/lib/api-key.js";
import { purgePackages } from "../../src/lib/apt.js";
import { NGINX_PACKAGES } from "../../src/lib/nginx-org.js";
import { loadSettings } from "../../src/lib/settings.js";
import { copyShippedConfig } from "./config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./fake-x1-validator.js";
import { scriptedPrompts } from "./scripted-prompts.js";

export const PASSWORD = "a long test password";

/** A url a command printed, with the key it carries. */
const PRINTED_URL = new RegExp(`^https://[^/]+/(${API_KEY_PATTERN})$`);

/**
 * Makes a run for a command, with a log the test can read.
 * @param {object} host  The fake host.
 * @param {object} settings  The tool's settings.
 * @param {object} [more]  More of the run: prompts and options.
 * @returns {object} The run, with `lines` holding what the log printed,
 *   and `printed` what the command printed as is.
 */
export function commandRun(host, settings, more = {}) {
  const lines = [];
  const printed = [];
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
    out: (line) => printed.push(line),
    options: {},
    lines,
    printed,
    ...more,
  };
}

/**
 * Finds the api keys in the urls a command printed.
 * @param {string[]} printed  What the command printed as is.
 * @returns {string[]} The keys, in order, once each.
 */
export function printedKeys(printed) {
  return printed
    .map((line) => PRINTED_URL.exec(line))
    .filter((match) => match !== undefined && match !== null)
    .map((match) => match[1]);
}

/**
 * Builds a fake validator and runs apply on it.
 * @param {object} [scenario]  The fake validator's scenario. Its settings
 *   default to the shipped ones, with the test's hostname.
 * @param {{savePassword?: boolean, acmeStaging?: boolean}} [choices]
 *   apply's answers, and whether it runs with --acme-staging.
 * @returns {Promise<{host: object, state: object, settings: object,
 *   scriptPath: string, apiKey: string}>} The fake, and the first api
 *   key, which apply printed.
 * @throws {Error} When apply doesn't finish, with its log, since every
 *   test that starts here needs apply's whole set-up.
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
  const [apiKey] = printedKeys(run.printed);
  return { host, state, settings, scriptPath, apiKey };
}

/**
 * Plays the operator's own purge of nginx and its modules, which
 * undo-apply leaves to them, through the fake's apt.
 * @param {object} host  The fake host.
 * @returns {Promise<void>}
 */
export async function purgeNginxByHand(host) {
  await purgePackages(host, NGINX_PACKAGES);
}
