/**
 * @file x1-validator-private-rpc/src/cli/ensure-there-is-at-least-one-rpc-api-key.js
 * @description
 * The `ensure-there-is-at-least-one-rpc-api-key` command, which a cron
 * line of its own runs every apiKeyCountCheckHours hours, apart from
 * ensure's every-minute run. It counts the hashes in nginx's list, with
 * no password, the way the commands that write the list count them.
 * With none, nginx refuses every request: the command sends that as a
 * Telegram alert on every run while the list stays empty, logs it, and
 * exits 1. Before apply has set nginx up, it does nothing and exits 0.
 * With --quiet, as from cron, it prints nothing while the list holds a
 * key.
 */

import {
  apiKeysCount,
  noApiKeyProblem,
  readMapCount,
} from "./hashed-api-keys.js";
import { hasSetup, readState } from "./state.js";
import { sendAlerts } from "./telegram.js";

/**
 * Runs ensure-there-is-at-least-one-rpc-api-key.
 * @param {object} run  The run: host, settings, paths, log, and options
 *   {quiet}.
 * @returns {Promise<number>} The exit code: 1 when nginx's list holds no
 *   key, 0 otherwise.
 */
export async function runEnsureApiKey(run) {
  const { host, settings, paths, log, options } = run;
  const state = readState(host, paths.statePath);
  if (!hasSetup(state)) {
    return 0;
  }
  const count = readMapCount(host, settings.hashedApiKeysMapPath);
  const problem = noApiKeyProblem(count);
  if (problem === "") {
    if (options.quiet !== true) {
      log.info("api keys", `nginx's list holds ${apiKeysCount(count)}.`);
    }
    return 0;
  }
  const message = `x1-validator-private-rpc on ${state.setup.hostname}: ${problem}`;
  /*-
   * Nothing is kept to send again, since the next run alerts anew while
   * the list stays empty.
   */
  await sendAlerts(run, [], [message]);
  return 1;
}
