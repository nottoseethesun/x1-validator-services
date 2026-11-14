/**
 * @file x1-validator-private-rpc/src/cli/ensure.js
 * @description
 * The `ensure` command, which cron runs every minute and x1console's git
 * hook runs after an update. It puts `--private-rpc` back into the start
 * script when an Update X1 Console took it out, runs the cheap checks,
 * sends the Telegram alerts they call for, and checks in with Cronitor.
 * Before apply has set nginx up, it does nothing and exits 0.
 *
 * It never edits the start script in the middle of an update: between
 * x1console's `git stash` and the end of its `git pull`, an edit would
 * make the pull fail. So every run but the hook's, a run by hand
 * included, leaves the script alone while `.git/index.lock` exists, or
 * while the script changed less than startScriptQuietSeconds ago, and
 * leaves the flag for a later run. The hook passes --from-git-hook,
 * which skips that wait, since git has finished when it runs the hook.
 *
 * While private rpc is off, as turn-off-private-rpc sets it, ensure
 * leaves the start script alone, and skips the three checks that the
 * rpc is private: the flag in the script, the flag in the running
 * validator, and where the rpc listens.
 *
 * With --quiet, as from cron, it prints only when it changes something
 * or sends an alert, so a lasting problem adds no line per minute to the
 * log.
 */

import path from "node:path";
import { decideAlerts, emptyAlertState, isAlertState } from "./alerts.js";
import { runChecks } from "./checks.js";
import { homePath, startScriptPathOf } from "./feature-paths.js";
import { checkIn } from "./heartbeat.js";
import { targetOf } from "./nginx-gate.js";
import { addPrivateRpc } from "./start-script.js";
import { readState } from "./state.js";
import { readTelegram, sendTelegram } from "./telegram.js";

/** The checks that the rpc is private, skipped while private rpc is off. */
const PRIVACY_CHECKS = ["flag-in-script", "flag-running", "rpc-private"];

/**
 * Puts the flag back into the start script when it's missing, unless an
 * update may be under way.
 * @param {object} host  The host.
 * @param {object} values  What the restore needs.
 * @param {string} values.scriptPath  The start script.
 * @param {string} values.x1consoleDir  x1console's folder.
 * @param {boolean} values.fromGitHook  Whether git's hook runs ensure.
 * @param {number} values.quietMs  How long after a change to the script
 *   every run but the hook's keeps off it.
 * @returns {{status: "present"|"restored"|"deferred"|"failed",
 *   detail: string}}
 */
export function restoreFlag(host, values) {
  const { scriptPath, x1consoleDir, fromGitHook, quietMs } = values;
  let edit;
  try {
    const text = host.readText(scriptPath);
    edit = addPrivateRpc(text, scriptPath);
  } catch (error) {
    return { status: "failed", detail: error.message };
  }
  if (!edit.changed) {
    return { status: "present", detail: "" };
  }
  const lockPath = path.join(x1consoleDir, ".git", "index.lock");
  const locked = host.exists(lockPath);
  const changedAt = host.modifiedAt(scriptPath);
  const recent = host.now() - changedAt < quietMs;
  if (!fromGitHook && (locked || recent)) {
    return {
      status: "deferred",
      detail: "x1console may be updating; ensure tries again next run.",
    };
  }
  const mode = host.fileMode(scriptPath);
  host.writeUserFile(scriptPath, edit.text, mode);
  return {
    status: "restored",
    detail: `Put --private-rpc back into ${scriptPath}.`,
  };
}

/**
 * Reads the alert state the last run kept.
 * @param {object} host  The host.
 * @param {string} alertStatePath  Its file.
 * @returns {import("./alerts.js").AlertState}
 */
function readAlertState(host, alertStatePath) {
  if (!host.exists(alertStatePath)) {
    return emptyAlertState();
  }
  try {
    const text = host.readText(alertStatePath);
    const state = JSON.parse(text);
    return isAlertState(state) ? state : emptyAlertState();
  } catch {
    return emptyAlertState();
  }
}

/**
 * Sends the pending messages, then the new ones, keeping those that
 * couldn't be sent. A failure is logged only when a message first fails.
 * @param {object} context  The run.
 * @param {string[]} pending  Messages that failed before.
 * @param {string[]} fresh  New messages.
 * @returns {Promise<string[]>} The messages still pending.
 */
async function sendAlerts(context, pending, fresh) {
  const { host, settings, log } = context;
  const telegram = readTelegram(host, settings);
  if (telegram === null) {
    for (const message of fresh) {
      log.problem(
        "alert",
        `${message} (alerts are off: x1console's Telegram files are missing)`,
      );
    }
    return [];
  }
  log.hide(telegram.token);
  const stillPending = [];
  for (const message of [...pending, ...fresh]) {
    try {
      await sendTelegram(
        host,
        telegram,
        message,
        settings.requestTimeoutSeconds * 1000,
      );
      log.info("alert", message);
    } catch (error) {
      if (!pending.includes(message)) {
        log.problem(
          "alert",
          `Couldn't send "${message}": ${error.message} It goes at the next run.`,
        );
      }
      stillPending.push(message);
    }
  }
  return stillPending;
}

/**
 * Runs ensure.
 * @param {object} run  What ensure works with: host, settings, paths,
 *   log, and options {quiet, fromGitHook}.
 * @returns {Promise<number>} The exit code: 1 when a check found a
 *   problem, 0 otherwise.
 */
export async function runEnsure(run) {
  const { host, settings, paths, log, options } = run;
  const state = readState(host, paths.statePath);
  if (state === null || state.setup === null) {
    return 0;
  }
  const privateRpcOn = state.privateRpc !== "off";
  const homeDir = host.homeDir();
  const x1consoleDir = homePath(settings.x1consoleDir, homeDir);
  const scriptPath = startScriptPathOf(settings, homeDir);
  const flag = privateRpcOn
    ? restoreFlag(host, {
        scriptPath,
        x1consoleDir,
        fromGitHook: options.fromGitHook === true,
        quietMs: settings.startScriptQuietSeconds * 1000,
      })
    : null;
  const target = targetOf(state.setup, settings);
  const found = await runChecks({
    host,
    settings,
    setup: state.setup,
    target,
    startScriptPath: scriptPath,
  });
  const checks = privateRpcOn
    ? found
    : found.filter((check) => !PRIVACY_CHECKS.includes(check.name));
  const scriptCheck = checks.find((check) => check.name === "flag-in-script");
  if (flag?.status === "deferred") {
    Object.assign(scriptCheck, { status: "unknown", detail: flag.detail });
  } else if (flag?.status === "failed") {
    // Why the flag couldn't go back, for the alert and the output.
    Object.assign(scriptCheck, { status: "problem", detail: flag.detail });
  }
  const last = readAlertState(host, paths.alertStatePath);
  const now = host.now();
  const { messages, next } = decideAlerts({
    checks,
    last,
    now,
    hostname: state.setup.hostname,
    reminderMinutes: settings.exposedReminderMinutes,
    flagRestored: flag?.status === "restored",
  });
  next.pending = await sendAlerts(run, last.pending, messages);
  host.makeUserDir(path.dirname(paths.alertStatePath), 0o755);
  const alertText = `${JSON.stringify(next, null, 2)}\n`;
  host.writeUserFile(paths.alertStatePath, alertText, 0o644);
  if (flag?.status === "restored") {
    log.info("ensure", flag.detail);
  }
  if (options.quiet !== true) {
    if (!privateRpcOn) {
      log.info(
        "ensure",
        "Private rpc is off, as turn-off-private-rpc set it: ensure leaves " +
          "the start script alone, and doesn't check that the rpc is private.",
      );
    }
    for (const check of checks) {
      log.info("ensure", `${check.status}: ${check.detail}`);
    }
  }
  await checkIn(host, {
    envPath: paths.envPath,
    log,
    timeoutMs: settings.requestTimeoutSeconds * 1000,
  });
  return checks.some((check) => check.status === "problem") ? 1 : 0;
}
