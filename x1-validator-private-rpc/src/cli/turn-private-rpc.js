/**
 * @file x1-validator-private-rpc/src/cli/turn-private-rpc.js
 * @description
 * The two commands that switch the validator's rpc between private and
 * public, once apply has set nginx up:
 *
 * - `turn-off-private-rpc` takes `--private-rpc` out of x1console's
 *   start script, and records the choice, so ensure stops putting the
 *   flag back and stops checking that the rpc is private. It asks first,
 *   unless given --yes, since the rpc is public after the validator's
 *   next start.
 * - `turn-on-private-rpc` puts the flag back, and records that choice,
 *   so ensure keeps the flag in place again. apply's sixth stage does the
 *   same.
 *
 * Either change reaches the validator at its next start, which is the
 * operator's to choose. nginx stays as it is, and keeps serving the
 * keyed url, since the rpc listens on the loopback address either way.
 * The choice goes into the tool's state before the script changes, so a
 * scheduled ensure that runs between the two already follows it.
 */

import { startScriptPathOf } from "./feature-paths.js";
import {
  addPrivateRpc,
  removePrivateRpc,
  RESTART_HOW,
} from "./start-script.js";
import { readAppliedState, writeState } from "./state.js";

/**
 * Reads the tool's state and the start script, for either command.
 * @param {object} run  The run: host, settings, paths.
 * @returns {{state: import("./state.js").State, scriptPath: string,
 *   text: string}}
 */
function readSwitch({ host, settings, paths }) {
  const state = readAppliedState(host, paths.statePath);
  const homeDir = host.homeDir();
  const scriptPath = startScriptPathOf(settings, homeDir);
  const text = host.readText(scriptPath);
  return { state, scriptPath, text };
}

/**
 * Writes the start script anew, keeping its mode.
 * @param {object} host  The host.
 * @param {string} scriptPath  The start script.
 * @param {string} text  Its new text.
 */
function writeScript(host, scriptPath, text) {
  const mode = host.fileMode(scriptPath);
  host.writeUserFile(scriptPath, text, mode);
}

/**
 * Runs turn-off-private-rpc.
 * @param {object} run  The run: host, settings, paths, log, prompts.
 * @returns {Promise<number>} The exit code: 1 when the operator said no.
 */
export async function runTurnOffPrivateRpc(run) {
  const { host, paths, log, prompts } = run;
  const name = "turn-off-private-rpc";
  const { state, scriptPath, text } = readSwitch(run);
  const edit = removePrivateRpc(text, scriptPath);
  if (state.privateRpc === "off" && !edit.changed) {
    log.info(name, "Private rpc is off already.");
    return 0;
  }
  const wanted = await prompts.confirm(
    "From its next start, the validator's rpc listens on every interface, " +
      "so anyone can reach it. Turn off private rpc?",
  );
  if (!wanted) {
    log.info(name, "Stopped. Nothing changed.");
    return 1;
  }
  state.privateRpc = "off";
  writeState(host, paths.statePath, state);
  if (edit.changed) {
    writeScript(host, scriptPath, edit.text);
  }
  log.info(
    name,
    `Private rpc is off: ${scriptPath} lacks --private-rpc, and ensure ` +
      "leaves it out until turn-on-private-rpc.",
  );
  log.info(
    name,
    `The running validator keeps its rpc as it is until its next start. ${RESTART_HOW}`,
  );
  return 0;
}

/**
 * Runs turn-on-private-rpc.
 * @param {object} run  The run: host, settings, paths, log.
 * @returns {Promise<number>} The exit code, 0.
 */
export async function runTurnOnPrivateRpc(run) {
  const { host, paths, log } = run;
  const name = "turn-on-private-rpc";
  const { state, scriptPath, text } = readSwitch(run);
  const edit = addPrivateRpc(text, scriptPath);
  if (state.privateRpc !== "on") {
    state.privateRpc = "on";
    writeState(host, paths.statePath, state);
  }
  if (!edit.changed) {
    log.info(
      name,
      "Private rpc is on: the start script carries --private-rpc.",
    );
    return 0;
  }
  writeScript(host, scriptPath, edit.text);
  log.info(
    name,
    `Private rpc is on: added --private-rpc to ${scriptPath}, and ensure ` +
      "keeps it there.",
  );
  log.info(name, `The validator takes it at its next start. ${RESTART_HOW}`);
  return 0;
}
