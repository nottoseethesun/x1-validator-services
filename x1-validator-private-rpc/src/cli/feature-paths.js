/**
 * @file x1-validator-private-rpc/src/cli/feature-paths.js
 * @description
 * Where the feature keeps its own files, found from this file's own
 * location, so the working directory never redirects a run:
 *
 * - the command the start wrapper, the git hook and the cron line call
 * - the key check that nginx runs
 * - the tool's state, and apply's record of what it changed
 * - ensure's alert state, lock and log
 * - the project's `.env`, which holds credentials that belong to one
 *   install
 *
 * git ignores every one of them except the code.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} FeaturePaths
 * @property {string} featureDir  The feature's folder.
 * @property {string} toolCli  The tool's command, `src/cli.js`.
 * @property {string} njsModuleSource  The key check, as the tool ships it.
 * @property {string} statePath  The tool's state: what apply set nginx up
 *   with, and whether private rpc is on.
 * @property {string} whatApplyChangedPath  apply's record of what it
 *   changed.
 * @property {string} alertStatePath  The last state of ensure's checks.
 * @property {string} tmpDir  Disposable files; holds the lock.
 * @property {string} lockPath  The lock flock holds during a scheduled
 *   ensure.
 * @property {string} logsDir  The scheduled ensure's log folder.
 * @property {string} ensureLogPath  The scheduled ensure's log.
 * @property {string} envPath  The project's `.env`.
 */

/**
 * Finds the feature's own paths.
 * @returns {FeaturePaths}
 */
export function featurePaths() {
  const featureDir = fileURLToPath(new URL("../../", import.meta.url));
  const appDataDir = path.join(featureDir, "app-data");
  const tmpDir = path.join(featureDir, "tmp");
  const logsDir = path.join(featureDir, "logs");
  return {
    featureDir,
    toolCli: path.join(featureDir, "src", "cli.js"),
    njsModuleSource: path.join(
      featureDir,
      "src",
      "njs",
      "x1-validator-private-rpc.js",
    ),
    statePath: path.join(appDataDir, "state.json"),
    whatApplyChangedPath: path.join(appDataDir, "what-apply-changed.json"),
    alertStatePath: path.join(appDataDir, "alert-state.json"),
    tmpDir,
    lockPath: path.join(tmpDir, "ensure.lock"),
    logsDir,
    ensureLogPath: path.join(logsDir, "ensure.log"),
    envPath: path.join(featureDir, "..", ".env"),
  };
}

/**
 * Turns a setting's path that starts with `~/` into one in the account's
 * home folder; other paths stay as they are.
 * @param {string} value  The setting's path.
 * @param {string} homeDir  The account's home folder, from its passwd
 *   entry, not from $HOME.
 * @returns {string}
 */
export function homePath(value, homeDir) {
  return value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
}

/**
 * Finds x1console's start script.
 * @param {object} settings  The tool's settings: x1consoleDir and
 *   startScriptFile.
 * @param {string} homeDir  The account's home folder.
 * @returns {string}
 */
export function startScriptPathOf(settings, homeDir) {
  const x1consoleDir = homePath(settings.x1consoleDir, homeDir);
  return path.join(x1consoleDir, settings.startScriptFile);
}
