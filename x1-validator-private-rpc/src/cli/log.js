/**
 * @file x1-validator-private-rpc/src/cli/log.js
 * @description
 * The commands' opt-in logger. Each line carries a stage tag, such as
 * `[nginx] started`. Secrets the logger is told about, the api key and
 * the Telegram token, are masked down to their last four characters
 * wherever they appear in a line. The password is never handed to the
 * logger, nor logged in any other way. Nothing patches console: the
 * logger writes through the functions it is given, console's by default.
 */

/**
 * Masks a secret down to its last four characters.
 * @param {string} secret  The secret.
 * @returns {string} Such as `…3f9a`.
 */
export function maskSecret(secret) {
  return `…${secret.slice(-4)}`;
}

/**
 * @typedef {object} Log
 * @property {(stage: string, line: string) => void} info  Prints a line
 *   on stdout.
 * @property {(stage: string, line: string) => void} problem  Prints a
 *   line on stderr.
 * @property {(secret: string) => void} hide  Masks this secret in every
 *   later line.
 */

/**
 * Makes a logger.
 * @param {object} [sinks]  Where lines go: console.log and console.error,
 *   unless a test passes its own.
 * @param {(line: string) => void} [sinks.out]  Takes stdout's lines.
 * @param {(line: string) => void} [sinks.err]  Takes stderr's lines.
 * @returns {Log}
 */
export function createLog({ out = console.log, err = console.error } = {}) {
  const secrets = [];
  const masked = (stage, line) => {
    let text = `[${stage}] ${line}`;
    for (const secret of secrets) {
      text = text.replaceAll(secret, maskSecret(secret));
    }
    return text;
  };
  return {
    info: (stage, line) => out(masked(stage, line)),
    problem: (stage, line) => err(masked(stage, line)),
    hide: (secret) => {
      if (secret.length > 4 && !secrets.includes(secret)) {
        secrets.push(secret);
      }
    },
  };
}
