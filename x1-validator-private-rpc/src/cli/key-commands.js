/**
 * @file x1-validator-private-rpc/src/cli/key-commands.js
 * @description
 * The commands that read the api key from the vault:
 *
 * - `unlock` asks for the password, hands the key to nginx and restarts
 *   it, for when the password isn't saved and nginx came back locked.
 * - `url` asks for the password and prints the rpc's full urls. It is
 *   the only command that ever shows the key.
 * - `decrypt-key --password-stdin`, which help doesn't list, is what the
 *   start wrapper runs, as the validator's account, with a saved
 *   password. It reads the password on stdin and prints the key, and
 *   refuses when its output is a terminal, so the key never lands on a
 *   screen by accident.
 */

import { askKnownPassword } from "./apply-key.js";
import { homePath } from "./feature-paths.js";
import { handKeyToNginx, targetOf, waitForUnlocked } from "./nginx-gate.js";
import { readAppliedState } from "./state.js";
import { API_KEY_SECRET, decryptSecret, readVault, secretOf } from "./vault.js";

/**
 * Reads what both password commands need: apply's setup and the
 * encrypted key.
 * @param {object} run  The run: host, settings, paths.
 * @returns {{setup: object, payload: object}}
 * @throws {Error} When apply hasn't set nginx up, or the vault holds no
 *   key, since there is then nothing to open.
 */
function keyAndSetup({ host, settings, paths }) {
  const { setup } = readAppliedState(host, paths.statePath);
  const homeDir = host.homeDir();
  const vaultPath = homePath(settings.vaultPath, homeDir);
  const vault = readVault(host, vaultPath);
  const payload = secretOf(vault, API_KEY_SECRET);
  if (payload === undefined || payload === null) {
    throw new Error(`${vaultPath} holds no api key. Run apply.`);
  }
  return { setup, payload };
}

/**
 * Runs unlock.
 * @param {object} run  The run: host, settings, paths, log, prompts.
 * @returns {Promise<number>} The exit code.
 */
export async function runUnlock(run) {
  const { host, settings, log, prompts } = run;
  const { setup, payload } = keyAndSetup(run);
  const tries = settings.passwordTries;
  const { plain: key } = await askKnownPassword(prompts, payload, tries);
  log.hide(key);
  log.info("unlock", "Handing the key to nginx, and restarting it.");
  handKeyToNginx(host, settings.keyHandOffPath, key);
  const target = targetOf(setup, settings);
  const gate = await waitForUnlocked(
    host,
    target,
    settings.requestTimeoutSeconds * 1000,
    settings.gatePollMs,
  );
  if (gate !== "unlocked") {
    log.problem("unlock", `nginx restarted, but its gate page says ${gate}.`);
    return 1;
  }
  log.info("unlock", "nginx holds the key, so keyed requests reach the rpc.");
  return 0;
}

/**
 * Runs url.
 * @param {object} run  The run: host, settings, paths, prompts, and out,
 *   which prints a line on stdout.
 * @returns {Promise<number>} The exit code.
 */
export async function runUrl(run) {
  const { setup, payload } = keyAndSetup(run);
  const tries = run.settings.passwordTries;
  const { plain: key } = await askKnownPassword(run.prompts, payload, tries);
  run.out(`https://${setup.hostname}/${key}`);
  run.out(`wss://${setup.hostname}/${key}`);
  return 0;
}

/**
 * Runs decrypt-key.
 * @param {object} run  The run: host, settings, and the command's own:
 *   stdinText, stdoutIsTerminal, write (stdout, as is) and err (stderr).
 * @returns {Promise<number>} The exit code.
 */
export async function runDecryptKey(run) {
  const { host, settings, stdinText, stdoutIsTerminal, write, err } = run;
  if (stdoutIsTerminal) {
    err("decrypt-key: refusing to print the key to a terminal.");
    return 1;
  }
  const homeDir = host.homeDir();
  const vaultPath = homePath(settings.vaultPath, homeDir);
  const vault = readVault(host, vaultPath);
  const payload = secretOf(vault, API_KEY_SECRET);
  if (payload === undefined || payload === null) {
    err(`decrypt-key: ${vaultPath} holds no api key.`);
    return 1;
  }
  const password = stdinText.replace(/\r?\n$/, "");
  try {
    const key = await decryptSecret(payload, password);
    write(key);
    return 0;
  } catch (error) {
    err(`decrypt-key: ${error.message}`);
    return 1;
  }
}
