/**
 * @file x1-validator-private-rpc/src/cli/ensure.js
 * @description
 * The `ensure` command, which cron runs every minute and the tool's git
 * hook runs after an update. While private rpc is on, it puts
 * `--private-rpc` back into the start script when an Update X1 Console
 * took it out. It runs its checks, sends the Telegram alerts they
 * call for, and checks in with Cronitor. Before apply has set nginx up,
 * it does nothing and exits 0.
 *
 * It never edits the start script in the middle of an update: between
 * x1console's `git stash` and the end of its `git pull`, an edit could
 * make the pull fail, when the update changes the start script. So every
 * run but the hook's, a run by hand included, leaves the script alone
 * while `.git/index.lock` exists, while a git process works in
 * x1console's folder, or while the script changed less than
 * startScriptQuietSeconds ago, and leaves the flag for a later run. git
 * holds the lock while the stash and the merge change the folder's
 * files, but not through the pull's fetch, which a slow network can
 * stretch past startScriptQuietSeconds: the git process covers that. The
 * quiet period covers the moment between the stash and the pull's start,
 * when no git runs. The hook passes --from-git-hook, which skips these
 * checks, since the merge is done when git runs the hook.
 *
 * It holds the start script's lock from its read of whether private rpc
 * is on until it has put the flag back or left it, so a command that
 * takes the flag out can't run in between. While another command holds
 * the lock, ensure changes nothing and exits 0, and its next run does
 * the work.
 *
 * While private rpc isn't on, before apply's flag stage or after
 * turn-off-private-rpc, ensure leaves the start script alone, and skips
 * the three checks that the rpc is private: the flag in the script, the
 * flag in the running validator, and where the rpc listens.
 *
 * With --quiet, as from cron, it prints only when it changes something
 * or sends an alert, and when its Cronitor check-in starts failing or
 * goes through again, so a lasting problem adds no line per minute to
 * the log. Its alert state records whether the last check-in failed.
 */

import path from "node:path";
import { decideAlerts, emptyAlertState, isAlertState } from "./alerts.js";
import { runChecks } from "./checks.js";
import { homePath, startScriptPathOf } from "./feature-paths.js";
import { checkIn } from "./heartbeat.js";
import { targetOf } from "./nginx-gate.js";
import { addPrivateRpc } from "./start-script.js";
import {
  hasSetup,
  lockStartScript,
  readState,
  START_SCRIPT_LOCKED,
} from "./state.js";
import { sendAlerts } from "./telegram.js";

/** The checks that the rpc is private, skipped while private rpc is off. */
const PRIVACY_CHECKS = ["flag-in-script", "flag-running", "rpc-private"];

/**
 * Puts the flag back into the start script when it's missing, unless an
 * update may be under way. A script it can't read, edit or write, such
 * as one on a full disk, gives "failed" with the reason, so ensure's
 * checks, alerts and Cronitor check-in still run.
 * @param {object} host  The host.
 * @param {object} values  What the restore needs.
 * @param {string} values.scriptPath  The start script.
 * @param {string} values.x1consoleDir  x1console's folder.
 * @param {boolean} values.fromGitHook  Whether the tool's git hook runs
 *   ensure.
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
  if (edit.changed === false) {
    return { status: "present", detail: "" };
  }
  const lockPath = path.join(x1consoleDir, ".git", "index.lock");
  const locked = host.exists(lockPath);
  // git pull, and the git fetch it runs, both show as "git".
  const gitRuns = host.programsIn(x1consoleDir).includes("git");
  const changedAt = host.modifiedAt(scriptPath);
  const recent = host.now() - changedAt < quietMs;
  if (
    fromGitHook === false &&
    (locked === true || gitRuns === true || recent === true)
  ) {
    const seconds = quietMs / 1000;
    return {
      status: "deferred",
      detail:
        "x1console may be updating, so ensure left the start script alone. " +
        "The cron job tries again every minute. Without it, run ensure " +
        `again once no git command works in ${x1consoleDir}, the script has ` +
        `gone unchanged for ${seconds} seconds, and ${lockPath} is gone. If ` +
        "the lock file stays while no git command works there, a git that " +
        "crashed left it, so delete it.",
    };
  }
  try {
    const mode = host.fileMode(scriptPath);
    host.writeUserFile(scriptPath, edit.text, mode);
  } catch (error) {
    // The flag-in-script check's alert carries this reason.
    return { status: "failed", detail: error.message };
  }
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
    // A field added since the file was written starts as an empty state's.
    return isAlertState(state)
      ? { ...emptyAlertState(), ...state }
      : emptyAlertState();
  } catch {
    return emptyAlertState();
  }
}

/**
 * Writes the alert state whole, making its folder when it's missing.
 * @param {object} host  The host.
 * @param {string} alertStatePath  Its file.
 * @param {import("./alerts.js").AlertState} state  The state.
 */
function writeAlertState(host, alertStatePath, state) {
  host.makeUserDir(path.dirname(alertStatePath), 0o755);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  host.writeUserFile(alertStatePath, text, 0o644);
}

/**
 * Prints what a run without --quiet found: why the checks that the rpc
 * is private were skipped, when they were, and every check's verdict.
 * @param {object} log  The logger.
 * @param {string} privateRpc  The operator's choice.
 * @param {import("./checks.js").Check[]} checks  The checks it ran.
 */
function printReport(log, privateRpc, checks) {
  if (privateRpc === "off") {
    log.info(
      "ensure",
      "Private rpc is off, as turn-off-private-rpc set it: ensure leaves " +
        "the start script alone, and doesn't check that the rpc is private.",
    );
  }
  if (privateRpc === "") {
    log.info(
      "ensure",
      "apply hasn't added --private-rpc yet, so ensure leaves the start " +
        "script alone, and doesn't check that the rpc is private.",
    );
  }
  for (const check of checks) {
    log.info("ensure", `${check.status}: ${check.detail}`);
  }
}

/**
 * Reads whether private rpc is on, and puts the flag back while it is,
 * holding the start script's lock from the one to the other.
 * @param {object} run  What ensure works with.
 * @returns {{privateRpc: string, flag: object|null}|null} The operator's
 *   choice, and how the restore went, which is null unless private rpc
 *   is on. Null when another command holds the lock.
 */
function keepFlagLocked(run) {
  const { host, settings, paths, options } = run;
  const release = lockStartScript(host, paths.statePath);
  if (release === undefined || release === null) {
    return null;
  }
  try {
    const state = readState(host, paths.statePath);
    const privateRpc =
      state === undefined || state === null ? "" : state.privateRpc;
    if (privateRpc !== "on") {
      return { privateRpc, flag: null };
    }
    const homeDir = host.homeDir();
    const scriptPath = startScriptPathOf(settings, homeDir);
    const x1consoleDir = homePath(settings.x1consoleDir, homeDir);
    const flag = restoreFlag(host, {
      scriptPath,
      x1consoleDir,
      fromGitHook: options.fromGitHook === true,
      quietMs: settings.startScriptQuietSeconds * 1000,
    });
    return { privateRpc, flag };
  } finally {
    release();
  }
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
  if (!hasSetup(state)) {
    return 0;
  }
  const kept = keepFlagLocked(run);
  if (kept === undefined || kept === null) {
    if (options.quiet !== true) {
      log.info("ensure", START_SCRIPT_LOCKED);
    }
    return 0;
  }
  const { privateRpc, flag } = kept;
  const privateRpcOn = privateRpc === "on";
  const homeDir = host.homeDir();
  const scriptPath = startScriptPathOf(settings, homeDir);
  const target = targetOf(state.setup, settings);
  const found = await runChecks({
    host,
    settings,
    setup: state.setup,
    target,
    startScriptPath: scriptPath,
  });
  const checks =
    privateRpcOn === true
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
    certificateReminderHours: settings.certificateReminderHours,
    flagRestored: flag?.status === "restored",
  });
  next.pending = await sendAlerts(run, last.pending, messages);
  writeAlertState(host, paths.alertStatePath, next);
  if (flag?.status === "restored") {
    log.info("ensure", flag.detail);
  }
  if (options.quiet !== true) {
    printReport(log, privateRpc, checks);
  }
  const checkedIn = await checkIn(host, {
    envPath: paths.envPath,
    log,
    timeoutMs: settings.requestTimeoutSeconds * 1000,
    tries: settings.cronitorCheckInTries,
    quiet: options.quiet === true,
    failedBefore: next.checkInFailed,
  });
  const checkInFailed = checkedIn === false;
  if (checkInFailed !== next.checkInFailed) {
    // Written again only on a change, so most runs write the state once.
    writeAlertState(host, paths.alertStatePath, { ...next, checkInFailed });
  }
  return checks.some((check) => check.status === "problem") ? 1 : 0;
}
