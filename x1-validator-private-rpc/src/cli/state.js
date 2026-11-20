/**
 * @file x1-validator-private-rpc/src/cli/state.js
 * @description
 * The tool's state, in `app-data/state.json`. It holds what apply set
 * nginx up with: the hostname, the address and the rpc port, which
 * ensure and url read, and which add-api-key and remove-api-key need
 * before they run. It also holds the operator's choice of a private or a
 * public rpc. apply's flag stage and turn-on-private-rpc set it on,
 * turn-off-private-rpc sets it off, and ensure follows it. The choice
 * starts out unset, so until apply has added the flag, or the operator
 * has turned private rpc on, ensure leaves the start script alone.
 * undo-apply unsets it whenever it clears the setup, so that no ensure
 * adds the flag before apply does. ensure does nothing while the state
 * holds no setup. A later apply records the setup again at its fifth
 * stage, which starts nginx, and from then on ensure acts on the choice.
 * But apply adds the flag only at its sixth stage, and installs the cron
 * job and the git hook that run ensure only at its seventh. Say
 * undo-apply left the choice on, and that later apply stopped between
 * its fifth and sixth stages. An ensure run by hand would then add the
 * flag. When apply ran again, it would find that flag and record it as
 * found, not as its own change. The next undo-apply takes back only
 * apply's changes, so it would leave the flag, and the rpc would stay
 * private after the validator's next start.
 *
 * The state also holds whether a saved password is left from an
 * earlier api keys' file, so apply treats it as no saved password until
 * the operator answers the save question again. What apply changed on
 * the machine is in its own record, which what-apply-changed.js keeps.
 *
 * The state's folder also carries the start script's lock. ensure holds
 * it while it reads the choice and puts the flag back, and so do the
 * commands that take the flag out, so none undoes another's change.
 */

import path from "node:path";
import { withFolderLock } from "./folder-lock.js";

const FORMAT_VERSION = 1;

/**
 * @typedef {object} State
 * @property {number} version  The file's format, 1.
 * @property {{hostname: string, publicIp: string, rpcPort: number,
 *   staging: boolean}|null} setup  What apply set up nginx with, or null
 *   until its nginx stage has run.
 * @property {""|"on"|"off"} privateRpc  Whether ensure keeps
 *   `--private-rpc` in the start script: "on" or "off", or "" until apply
 *   or turn-on-private-rpc turns it on, and again once undo-apply has run.
 * @property {boolean} savedPasswordStale  Whether a saved password is
 *   left from an earlier api keys' file, and so can't open this one.
 */

/**
 * Makes the state of a machine apply hasn't set up yet.
 * @returns {State}
 */
export function emptyState() {
  return {
    version: FORMAT_VERSION,
    setup: null,
    privateRpc: "",
    savedPasswordStale: false,
  };
}

/**
 * Reads the tool's state.
 * @param {object} host  The host.
 * @param {string} statePath  The state's file.
 * @returns {State|null} The state, or null when apply hasn't run.
 * @throws {Error} When the file isn't one this tool wrote, since a
 *   command that guessed at it could act on the wrong setup.
 */
export function readState(host, statePath) {
  if (!host.exists(statePath)) {
    return null;
  }
  let state;
  try {
    const text = host.readText(statePath);
    state = JSON.parse(text);
  } catch (error) {
    throw new Error(`${statePath} isn't valid json.`, { cause: error });
  }
  if (state?.version !== FORMAT_VERSION) {
    throw new Error(`${statePath} isn't a state this tool wrote.`);
  }
  // A field added since the file was written starts as an empty state's.
  return { ...emptyState(), ...state };
}

/**
 * Reads the tool's state, for a command that works on what apply set up.
 * @param {object} host  The host.
 * @param {string} statePath  The state's file.
 * @returns {State} The state, with apply's setup in it.
 * @throws {Error} When apply hasn't set nginx up yet, since the command
 *   then has nothing to work on.
 */
export function readAppliedState(host, statePath) {
  const state = readState(host, statePath);
  if (!hasSetup(state)) {
    throw new Error("apply hasn't set nginx up yet. Run apply first.");
  }
  return state;
}

/**
 * Says whether there's a state that holds what apply set nginx up with.
 * @param {State|null} state  The state, or null when there's none.
 * @returns {boolean}
 */
export function hasSetup(state) {
  return (
    state !== undefined &&
    state !== null &&
    state.setup !== undefined &&
    state.setup !== null
  );
}

/**
 * Writes the tool's state whole, making its folder when it's missing.
 * @param {object} host  The host.
 * @param {string} statePath  The state's file.
 * @param {State} state  The state.
 */
export function writeState(host, statePath, state) {
  host.makeUserDir(path.dirname(statePath), 0o755);
  host.writeUserFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o644);
}

/** What a command says when another one holds the start script's lock. */
export const START_SCRIPT_LOCKED =
  "Another command is changing the start script, so this one changed " +
  "nothing. Run it again once that one is done.";

/**
 * Takes the start script's lock: flock's lock on the folder of the
 * tool's state, which records whether private rpc is on. ensure holds
 * it from its read of that choice to its write of the start script, and
 * each command that takes the flag out holds it for its own read and
 * write, so neither undoes the other's change. The host keeps it until
 * it's let go, or until the command ends, even when it's killed.
 * @param {object} host  The host.
 * @param {string} statePath  The state's file, whose folder must exist.
 * @returns {(() => void)|null} What lets go of it, or null when another
 *   command holds it.
 */
export function lockStartScript(host, statePath) {
  return host.lockFolder(path.dirname(statePath));
}

/**
 * Runs a change to the start script while holding its lock.
 * @template T
 * @param {object} host  The host.
 * @param {string} statePath  The state's file, whose folder must exist.
 * @param {() => T} change  The change.
 * @returns {Promise<T>} What the change returns.
 * @throws {Error} When another command holds the lock, before the change
 *   starts, since that command's change and this one would undo each
 *   other.
 */
export function withStartScriptLock(host, statePath, change) {
  const folder = path.dirname(statePath);
  return withFolderLock(host, folder, START_SCRIPT_LOCKED, change);
}
