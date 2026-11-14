/**
 * @file x1-validator-private-rpc/src/cli/start-script.js
 * @description
 * Reads and edits x1console's start script, `start_validator.sh`, which
 * starts the validator with one long command: `tachyon-validator` and
 * its flags, one per line, each line but the last ending in a backslash.
 * The edit adds one word, `--private-rpc`, to the line that sets the
 * rpc port. The validator's rpc then listens on 127.0.0.1 alone, and the
 * node no longer publishes it, from the validator's next start.
 *
 * The port line must have exactly the form `--rpc-port N \`, once in the
 * file; any other layout is refused rather than guessed at. A command
 * that binds the rpc to an address other than 127.0.0.1 is refused too,
 * since Tachyon would bind there even with the flag. A command that
 * already carries the flag, on any of its lines, is left alone, so a
 * future x1console that adds the flag itself needs nothing from the
 * tool. Removing the flag takes back exactly the word the edit added.
 *
 * Everything here works on the script's text, so tests feed it fixtures.
 */

const PRIVATE_RPC = "--private-rpc";
const RPC_PORT = "--rpc-port";
const BIND_ADDRESS = "--rpc-bind-address";
const LOOPBACK = "127.0.0.1";

/** How to restart the validator, so it takes a change to the script. */
export const RESTART_HOW =
  "Restart it from x1console: choose 2. Validator, then 1. Start/Restart " +
  "Validator, at a moment when the Validator screen shows no leader slot " +
  "coming soon.";

/**
 * @typedef {object} StartScript
 * @property {number} rpcPort  The port the validator's rpc listens on.
 * @property {boolean} hasFlag  Whether the validator's command carries
 *   `--private-rpc`, on any of its lines.
 * @property {number} portLine  Which line, counted from 0, sets the port.
 */

/**
 * Splits a line into its words.
 * @param {string} line  The line.
 * @returns {string[]}
 */
function words(line) {
  return line.trim().split(/\s+/);
}

/**
 * Finds the validator's command: the line that runs tachyon-validator,
 * and every line that a trailing backslash joins to it.
 * @param {string[]} lines  The script's lines.
 * @returns {string[]} The command's lines; none when no line runs it.
 */
function commandLines(lines) {
  const runsValidator = (line) =>
    !line.trim().startsWith("#") &&
    words(line).some(
      (word) =>
        word === "tachyon-validator" || word.endsWith("/tachyon-validator"),
    );
  const start = lines.findIndex(runsValidator);
  if (start === -1) {
    return [];
  }
  let end = start;
  while (lines.at(end).trimEnd().endsWith("\\") && end + 1 < lines.length) {
    end += 1;
  }
  return lines.slice(start, end + 1);
}

/**
 * Reads a line of the form `--rpc-port N \`, or `--rpc-port N
 * --private-rpc \` once the edit is made.
 * @param {string} line  The line.
 * @returns {{port: number, flagged: boolean}|null} The port, and whether
 *   the line carries the flag; null for any other line.
 */
function readPortLine(line) {
  const parts = words(line);
  const flagged = parts.length === 4 && parts[2] === PRIVATE_RPC;
  const formed =
    parts[0] === RPC_PORT &&
    parts.at(-1) === "\\" &&
    (parts.length === 3 || flagged) &&
    /^\d+$/.test(parts[1]);
  return formed ? { port: Number.parseInt(parts[1], 10), flagged } : null;
}

/**
 * Finds the lines of the form readPortLine accepts.
 * @param {string[]} lines  The script's lines.
 * @returns {{port: number, flagged: boolean, index: number}[]}
 */
function portLines(lines) {
  return lines.flatMap((line, index) => {
    const read = readPortLine(line);
    return read === null ? [] : [{ ...read, index }];
  });
}

/**
 * Reads the address the validator's command binds its rpc to, as
 * `--rpc-bind-address A` or `--rpc-bind-address=A`.
 * @param {string[]} commandWords  The command's words.
 * @returns {string|null} The address; null when the command names none.
 */
function bindAddress(commandWords) {
  const index = commandWords.findIndex(
    (word) => word === BIND_ADDRESS || word.startsWith(`${BIND_ADDRESS}=`),
  );
  if (index === -1) {
    return null;
  }
  const word = commandWords.at(index);
  return word === BIND_ADDRESS
    ? (commandWords.at(index + 1) ?? "")
    : word.slice(BIND_ADDRESS.length + 1);
}

/**
 * Reads what the edit needs from the start script.
 * @param {string} text  The script.
 * @param {string} scriptPath  Its path, for the errors.
 * @returns {StartScript}
 * @throws {Error} When no line runs tachyon-validator, when the command
 *   binds the rpc to an address other than 127.0.0.1, or when the script
 *   doesn't hold exactly one port line, since the tool never guesses at
 *   a changed layout.
 */
export function readStartScript(text, scriptPath) {
  const lines = text.split("\n");
  const commandWords = commandLines(lines).flatMap(words);
  if (commandWords.length === 0) {
    throw new Error(
      `${scriptPath} has no line that runs tachyon-validator, so the tool ` +
        "can't find the validator's flags.",
    );
  }
  const address = bindAddress(commandWords);
  if (address !== null && address !== LOOPBACK) {
    throw new Error(
      `${scriptPath} binds the rpc to ${address} with ${BIND_ADDRESS}, so ` +
        `${PRIVATE_RPC} wouldn't keep it on ${LOOPBACK}. Remove that flag ` +
        "or set it to 127.0.0.1, then run the tool again.",
    );
  }
  const found = portLines(lines);
  if (found.length !== 1) {
    throw new Error(
      `${scriptPath} must hold exactly one line of the form ` +
        `"${RPC_PORT} N \\", where N is the rpc's port, but it holds ` +
        `${found.length}. The tool doesn't guess at a changed layout.`,
    );
  }
  return {
    rpcPort: found[0].port,
    hasFlag: commandWords.includes(PRIVATE_RPC),
    portLine: found[0].index,
  };
}

/**
 * Adds `--private-rpc` to the port line, unless the validator's command
 * already carries it.
 * @param {string} text  The script.
 * @param {string} scriptPath  Its path, for the errors.
 * @returns {{text: string, changed: boolean}} The script, and whether
 *   the edit changed it.
 * @throws {Error} As readStartScript does, so a layout it can't read is
 *   never edited.
 */
export function addPrivateRpc(text, scriptPath) {
  const script = readStartScript(text, scriptPath);
  if (script.hasFlag) {
    return { text, changed: false };
  }
  const lines = text.split("\n");
  const line = lines.at(script.portLine);
  const beforeBackslash = line.slice(0, line.lastIndexOf("\\")).trimEnd();
  lines.splice(script.portLine, 1, `${beforeBackslash} ${PRIVATE_RPC} \\`);
  return { text: lines.join("\n"), changed: true };
}

/**
 * Takes back the edit: removes `--private-rpc`, and the space before it,
 * from the port line. A flag anywhere else isn't the tool's, so it stays.
 * @param {string} text  The script.
 * @param {string} scriptPath  Its path, for the error.
 * @returns {{text: string, changed: boolean}} The script, and whether
 *   anything was removed.
 * @throws {Error} When more than one port line carries the flag, since
 *   the tool then can't tell which one it edited.
 */
export function removePrivateRpc(text, scriptPath) {
  const lines = text.split("\n");
  const flagged = portLines(lines).filter((line) => line.flagged);
  if (flagged.length > 1) {
    throw new Error(
      `${scriptPath} holds ${flagged.length} port lines with ` +
        `${PRIVATE_RPC}, so the tool can't tell which one it added.`,
    );
  }
  if (flagged.length === 0) {
    return { text, changed: false };
  }
  const index = flagged[0].index;
  lines.splice(index, 1, lines.at(index).replace(` ${PRIVATE_RPC}`, ""));
  return { text: lines.join("\n"), changed: true };
}
