/**
 * @file x1-validator-private-rpc/src/lib/command-result.js
 * @description
 * Turns a failed command into an error that says what failed. Every
 * command the tool runs on the host returns its exit code and output;
 * a step that needs the command to succeed passes the result through
 * here, so the error names the step, the exit code and what the command
 * printed on stderr.
 */

/**
 * @typedef {object} CommandResult
 * @property {number} status  The exit code, or 1 for a command killed by
 *   a signal.
 * @property {string} stdout  What the command printed on stdout.
 * @property {string} stderr  What the command printed on stderr.
 */

/**
 * Returns a command's result when it succeeded.
 * @param {CommandResult} result  The command's result.
 * @param {string} what  The step, in words, such as "Masking nginx".
 * @returns {CommandResult} The same result.
 * @throws {Error} When the command exited with a code other than 0, naming
 *   the step, the code and the command's stderr, so a failed step stops
 *   the run there with its reason, rather than going on as if it worked.
 */
export function mustSucceed(result, what) {
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${what} failed with exit code ${result.status}` +
        (detail === "" ? "." : `: ${detail}`),
    );
  }
  return result;
}
