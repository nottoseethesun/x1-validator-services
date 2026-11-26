/**
 * @file x1-validator-private-rpc/src/cli/heartbeat.js
 * @description
 * ensure's check-in with Cronitor, the dead-man's switch that alerts the
 * operator when the check-ins stop: when ensure's cron job silently
 * breaks, because the folder moved, a setting has a typo, or Node.js is
 * gone. The check-in says only that ensure ran, never what it found.
 * Findings go out as the tool's own Telegram alerts.
 *
 * The monitor's telemetry url is a credential, so it lives in the
 * project's `.env`, as X1_PRIVATE_RPC_CRONITOR_URL, and never in a log.
 * Without it, ensure doesn't check in. A check-in that fails is tried
 * again, up to the number of tries the settings give. Each failed try is
 * logged with Cronitor's http status, or, when no answer came, with the
 * request's error, which never holds the url's path, where the secret
 * is. Under ensure's --quiet, the failed tries are logged only when the
 * check-ins start failing, which ensure's alert state records, so an
 * outage of Cronitor's adds its lines to the log once, not every minute.
 */

import dotenv from "dotenv";

/** The `.env` entry that holds the telemetry url. */
export const CRONITOR_URL = "X1_PRIVATE_RPC_CRONITOR_URL";

/**
 * Reads the telemetry url from the project's `.env`.
 * @param {object} host  The host.
 * @param {string} envPath  The `.env` file.
 * @returns {string|null} The url, or null when none is set.
 */
export function cronitorUrl(host, envPath) {
  if (!host.exists(envPath)) {
    return null;
  }
  const text = host.readText(envPath);
  const values = new Map(Object.entries(dotenv.parse(text)));
  const url = (values.get(CRONITOR_URL) ?? "").trim();
  return url === "" ? null : url;
}

/**
 * Describes one failed try of the check-in.
 * @param {number} attempt  The try, from 1.
 * @param {number} tries  How many tries there are.
 * @param {{status: number, body: string}} response  Cronitor's answer,
 *   or status 0, with the request's error in place of the body, when no
 *   answer came.
 * @returns {string}
 */
function failedTry(attempt, tries, response) {
  const which = `Cronitor's check-in, try ${attempt} of ${tries},`;
  return response.status === 0
    ? `${which} got no answer: ${response.body}`
    : `${which} answered http ${response.status}.`;
}

/**
 * Checks in with Cronitor, when the url is set. Without --quiet, each
 * failed try is logged as it happens. Under --quiet, the failed tries are
 * logged once every try has failed, and only when the last run's
 * check-in went through. A check-in that goes through after the last
 * run's failed says so.
 * @param {object} host  The host.
 * @param {object} values  What the check-in needs.
 * @param {string} values.envPath  The `.env` file.
 * @param {import("./log.js").Log} values.log  The logger, which hides
 *   the url.
 * @param {number} values.timeoutMs  How long to wait for Cronitor.
 * @param {number} values.tries  How many times to try the check-in.
 * @param {boolean} values.quiet  Whether ensure runs with --quiet.
 * @param {boolean} values.failedBefore  Whether the last run's check-in
 *   failed, as ensure's alert state records it.
 * @returns {Promise<boolean|null>} Whether the check-in went through, or
 *   null when no url is set.
 */
export async function checkIn(host, values) {
  const { envPath, log, timeoutMs, tries, quiet, failedBefore } = values;
  const url = cronitorUrl(host, envPath);
  if (url === undefined || url === null) {
    return null;
  }
  log.hide(url);
  const telemetry = new URL(url);
  telemetry.searchParams.set("state", "complete");
  const failures = [];
  for (let attempt = 1; attempt <= tries; attempt++) {
    const response = await host
      .httpsGet(telemetry.href, timeoutMs)
      .catch((error) => ({ status: 0, body: error.message }));
    if (response.status >= 200 && response.status < 300) {
      if (failedBefore === true) {
        log.info("heartbeat", "Cronitor's check-in went through again.");
      }
      return true;
    }
    failures.push(failedTry(attempt, tries, response));
    if (quiet !== true) {
      log.problem("heartbeat", failures.at(-1));
    }
  }
  if (quiet === true && failedBefore !== true) {
    for (const line of failures) {
      log.problem("heartbeat", line);
    }
  }
  return false;
}
