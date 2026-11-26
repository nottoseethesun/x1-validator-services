/**
 * @file x1-validator-private-rpc/src/cli/render-watchers.js
 * @description
 * Writes out the two watchers that run `ensure`, which puts
 * `--private-rpc` back into x1console's start script after an Update X1
 * Console takes it out, and sends the tool's alerts:
 *
 * - The tool's git hook, `.git/hooks/post-merge` in x1console's checkout,
 *   which git runs after a pull that brings in new commits. git ignores a
 *   post-merge hook's exit code, so the hook can never fail an x1console
 *   update.
 * - The cron line, which runs `ensure` every minute and covers a pull
 *   that brought nothing new and so ran no hook. flock skips a run while
 *   the previous one is still going.
 *
 * It also writes the cron line that runs
 * `ensure-there-is-at-least-one-rpc-api-key` every few hours, on the
 * hour, and adds its output to ensure's log.
 *
 * Each cron line first makes any folder it writes in that's missing, so
 * deleting `tmp/` or `logs/` stops no run.
 *
 * Each names the Node.js and the `src/cli.js` the tool runs from, by full
 * path, quoted for the shell. A hook is known as the tool's by its
 * shape, whatever paths it names. Every function here is pure.
 */

import path from "node:path";
import { shellQuote } from "../lib/render-host-files.js";

/**
 * Writes the tool's git hook, for x1console's checkout.
 * @param {{nodeBin: string, toolCli: string}} values  The Node.js and the
 *   tool's `src/cli.js`, by full path.
 * @returns {string} The hook's text.
 */
export function renderGitHook({ nodeBin, toolCli }) {
  return `#!/bin/sh
# x1-validator-private-rpc: after "Update X1 Console" pulls new commits,
# put --private-rpc back into start_validator.sh. Never fails the pull.
${shellQuote(nodeBin)} ${shellQuote(toolCli)} ensure --quiet --from-git-hook || true
`;
}

/**
 * Tells whether a hook is one renderGitHook wrote, for any Node.js and
 * any copy of the tool, such as an earlier apply's. It reads the two
 * paths the hook's command names, and writes the hook again from them.
 * @param {string} text  The hook's text.
 * @returns {boolean}
 */
export function isToolHook(text) {
  const command = text.split("\n").at(-2) ?? "";
  const words = /^('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') /.exec(command);
  if (words === undefined || words === null) {
    return false;
  }
  const [nodeBin, toolCli] = words
    .slice(1)
    .map((word) => word.slice(1, -1).replaceAll("'\\''", "'"));
  const hook = renderGitHook({ nodeBin, toolCli });
  return hook === text;
}

/**
 * Refuses a path that can't go in a crontab line.
 * @param {string[]} values  The paths.
 * @throws {Error} When a path holds a `%` or a line break, which cron
 *   would read as the end of the command.
 */
function refuseCronBreaks(values) {
  for (const value of values) {
    if (/[%\n]/.test(value)) {
      throw new Error(
        `${JSON.stringify(value)} can't go in a crontab line, since cron ` +
          "reads a % or a line break as the end of the command.",
      );
    }
  }
}

/**
 * Writes the start of a crontab line's command, which makes the folders
 * of the files the line writes when they're missing, with the mode apply
 * gives them. It never makes a folder above them, so a line left behind
 * after the project moved makes nothing at the old place. Its errors go
 * nowhere, since a folder that's there already is the usual case, and the
 * line runs on either way.
 * @param {string[]} files  The files, by full path.
 * @returns {string}
 */
function makeFoldersOf(files) {
  const folders = files.map((file) => shellQuote(path.dirname(file)));
  return `mkdir -m 755 ${folders.join(" ")} 2>/dev/null; `;
}

/**
 * Writes the crontab line that runs `ensure` every minute, after making
 * any missing folder of its lock or its log.
 * @param {object} values  What the line needs, each by full path.
 * @param {string} values.nodeBin  The Node.js the tool runs with.
 * @param {string} values.toolCli  The tool's `src/cli.js`.
 * @param {string} values.lockPath  The lock flock holds during a run.
 * @param {string} values.logPath  Where the runs' output goes.
 * @returns {string} The line, without its line end.
 * @throws {Error} When a path holds a `%` or a line break, which cron
 *   would read as the end of the command.
 */
export function renderCronLine({ nodeBin, toolCli, lockPath, logPath }) {
  refuseCronBreaks([nodeBin, toolCli, lockPath, logPath]);
  return (
    `* * * * * ${makeFoldersOf([lockPath, logPath])}flock -n ` +
    `${shellQuote(lockPath)} ${shellQuote(nodeBin)} ${shellQuote(toolCli)} ` +
    `ensure --quiet >> ${shellQuote(logPath)} 2>&1`
  );
}

/**
 * Writes the crontab line that runs
 * `ensure-there-is-at-least-one-rpc-api-key` every few hours, after
 * making its log's folder when it's missing.
 * @param {object} values  What the line needs.
 * @param {string} values.nodeBin  The Node.js the tool runs with.
 * @param {string} values.toolCli  The tool's `src/cli.js`.
 * @param {string} values.logPath  Where the runs' output goes: ensure's
 *   log.
 * @param {number} values.hours  How many hours apart the runs are.
 * @returns {string} The line, without its line end.
 * @throws {Error} When a path holds a `%` or a line break, which cron
 *   would read as the end of the command.
 */
export function renderKeyCountCronLine({ nodeBin, toolCli, logPath, hours }) {
  refuseCronBreaks([nodeBin, toolCli, logPath]);
  return (
    `0 */${hours} * * * ${makeFoldersOf([logPath])}${shellQuote(nodeBin)} ` +
    `${shellQuote(toolCli)} ensure-there-is-at-least-one-rpc-api-key ` +
    `--quiet >> ${shellQuote(logPath)} 2>&1`
  );
}
