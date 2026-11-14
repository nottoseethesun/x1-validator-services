/**
 * @file x1-validator-private-rpc/src/cli/state.js
 * @description
 * The tool's state, in `app-data/state.json`. It holds what apply set
 * nginx up with: the hostname, the address and the rpc port, which
 * ensure, unlock and url read. It also holds the operator's choice of a
 * private or a public rpc. apply and turn-on-private-rpc set it on,
 * turn-off-private-rpc sets it off, and ensure follows it. What apply
 * changed on the machine is in its own record, which
 * what-apply-changed.js keeps.
 */

import path from "node:path";

const FORMAT_VERSION = 1;

/**
 * @typedef {object} State
 * @property {number} version  The file's format, 1.
 * @property {{hostname: string, publicIp: string, rpcPort: number,
 *   staging: boolean}|null} setup  What apply set up nginx with; null
 *   until its nginx stage has run.
 * @property {"on"|"off"} privateRpc  Whether ensure keeps
 *   `--private-rpc` in the start script.
 */

/**
 * Makes the state of a machine apply hasn't set up yet.
 * @returns {State}
 */
export function emptyState() {
  return {
    version: FORMAT_VERSION,
    setup: null,
    privateRpc: "on",
  };
}

/**
 * Reads the tool's state.
 * @param {object} host  The host.
 * @param {string} statePath  The state's file.
 * @returns {State|null} The state, or null when apply hasn't run.
 * @throws {Error} When the file isn't one this tool wrote.
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
  return state;
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
  if (state === null || state.setup === null) {
    throw new Error("apply hasn't set nginx up yet. Run apply first.");
  }
  return state;
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
