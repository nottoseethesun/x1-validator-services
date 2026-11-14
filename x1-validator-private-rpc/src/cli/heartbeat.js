/**
 * @file x1-validator-private-rpc/src/cli/heartbeat.js
 * @description
 * ensure's check-in with Cronitor, the dead-man's switch that alerts the
 * operator when the check-ins stop: when ensure's cron job silently
 * breaks, because the folder moved, a setting has a typo, or Node.js is
 * gone. The check-in says only that ensure ran, never what it found;
 * findings go out as the tool's own Telegram alerts.
 *
 * The monitor's telemetry url is a credential, so it lives in the
 * project's `.env`, as X1_PRIVATE_RPC_CRONITOR_URL, and never in a log.
 * Without it, ensure doesn't check in. A check-in that fails is tried
 * once more, and the http code is logged.
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
 * Checks in with Cronitor, when the url is set.
 * @param {object} host  The host.
 * @param {object} values  What the check-in needs.
 * @param {string} values.envPath  The `.env` file.
 * @param {import("./log.js").Log} values.log  The logger, which hides
 *   the url.
 * @param {number} values.timeoutMs  How long to wait for Cronitor.
 * @returns {Promise<boolean|null>} Whether the check-in went through;
 *   null when no url is set.
 */
export async function checkIn(host, { envPath, log, timeoutMs }) {
  const url = cronitorUrl(host, envPath);
  if (url === null) {
    return null;
  }
  log.hide(url);
  const telemetry = new URL(url);
  telemetry.searchParams.set("state", "complete");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await host
      .httpsGet(telemetry.href, timeoutMs)
      .catch((error) => ({ status: 0, body: error.message }));
    if (response.status >= 200 && response.status < 300) {
      return true;
    }
    log.problem(
      "heartbeat",
      `Cronitor's check-in, try ${attempt} of 2, answered http ${response.status}.`,
    );
  }
  return false;
}
