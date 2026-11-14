/**
 * @file x1-validator-private-rpc/src/cli/render-watchers.js
 * @description
 * Writes out the two watchers that run `ensure`, which puts
 * `--private-rpc` back into x1console's start script after an Update X1
 * Console takes it out, and sends the tool's alerts:
 *
 * - The git hook, x1console's `.git/hooks/post-merge`, which git runs
 *   after a pull that brings in new commits. It always exits 0, so it can
 *   never fail an x1console update.
 * - The cron line, which runs `ensure` every minute and covers a pull
 *   that brought nothing new and so ran no hook. flock skips a run while
 *   the previous one is still going.
 *
 * Both name the Node.js and the `src/cli.js` the tool runs from, by full
 * path, quoted for the shell. A hook is known as the tool's by its
 * shape, whatever paths it names. Every function here is pure.
 */

import { shellQuote } from "../lib/render-host-files.js";

/**
 * Writes x1console's post-merge hook.
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
  if (words === null) {
    return false;
  }
  const [nodeBin, toolCli] = words
    .slice(1)
    .map((word) => word.slice(1, -1).replaceAll("'\\''", "'"));
  const hook = renderGitHook({ nodeBin, toolCli });
  return hook === text;
}

/**
 * Writes the crontab line that runs `ensure` every minute.
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
  for (const value of [nodeBin, toolCli, lockPath, logPath]) {
    if (/[%\n]/.test(value)) {
      throw new Error(
        `${JSON.stringify(value)} can't go in a crontab line, since cron ` +
          "reads a % or a line break as the end of the command.",
      );
    }
  }
  return (
    `* * * * * flock -n ${shellQuote(lockPath)} ${shellQuote(nodeBin)} ` +
    `${shellQuote(toolCli)} ensure --quiet >> ${shellQuote(logPath)} 2>&1`
  );
}
