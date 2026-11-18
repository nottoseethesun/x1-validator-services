/**
 * @file x1-validator-private-rpc/src/cli/remove-api-key.js
 * @description
 * The `remove-api-key` command: it asks for an api key at a prompt that
 * shows nothing of what's typed or pasted, hashes it, and removes that
 * hash and its record from hashed-api-keys.json. It asks no
 * x1-validator-services password, since the hashes are unencrypted. It
 * holds the api keys' lock from its read of the file to its last
 * write, and gets sudo, which writing nginx's list needs, after its
 * questions and before its first write. It hands nginx the new list
 * first, so nginx refuses the key from then on, and writes the file last.
 * So when a step fails, the file still holds the key, and running the
 * command again removes it. Every other command that writes nginx's list
 * writes it from the file, and would hand the key back, so a failed
 * write of the file says to run remove-api-key again before any of them.
 *
 * A key that isn't in the file removes nothing, and the command exits 1.
 * So does a text without a key's form. The command never repeats such a
 * text, since it may be a real key typed wrong. Removing the last key
 * asks first, since nginx then refuses every request until add-api-key
 * makes another.
 */

import path from "node:path";
import { API_KEY_HEX_DIGITS, isApiKey } from "../lib/api-key.js";
import { hashApiKey } from "../lib/key-hash-map.js";
import { hashedApiKeysPathOf } from "./feature-paths.js";
import {
  apiKeysCount,
  askSudoFirst,
  handListToNginx,
  readHashedApiKeys,
  withApiKeysLock,
  writeHashedApiKeys,
} from "./hashed-api-keys.js";
import { readAppliedState } from "./state.js";

/** The prompt for the key to remove. */
export const REMOVE_KEY_PROMPT = "Paste the api key to remove: ";

/** The question before the last key goes. */
const LAST_KEY_QUESTION =
  "This is the last api key. Without one, nginx refuses every request " +
  "until add-api-key makes another. Remove it?";

/**
 * Says the file is missing, so there's no key to remove.
 * @param {string} filePath  The file.
 * @returns {Error}
 */
function missingFile(filePath) {
  return new Error(`${filePath} is missing, so there's no key to remove.`);
}

/**
 * Says a removal is half done: nginx refuses the key, but the file still
 * holds it, and the next command that writes nginx's list writes it from
 * the file.
 * @param {string} filePath  The file.
 * @param {string} reason  Why the file's write failed.
 * @returns {string}
 */
export function halfRemoved(filePath, reason) {
  return (
    `Couldn't write ${filePath} (${reason}). nginx refuses the key now, ` +
    "but the file still holds it. Run remove-api-key again before any " +
    "other key command or apply, which would give the key back to nginx."
  );
}

/**
 * Removes the key, while the caller holds the api keys' lock.
 * @param {object} run  The run.
 * @param {string} filePath  The file.
 * @returns {Promise<number>} The exit code: 1 when nothing was removed.
 */
async function removeUnderLock(run, filePath) {
  const { host, log, prompts } = run;
  const keys = readHashedApiKeys(host, filePath);
  if (keys === undefined || keys === null) {
    throw missingFile(filePath);
  }
  const answer = await prompts.password(REMOVE_KEY_PROMPT);
  const apiKey = answer.trim();
  if (!isApiKey(apiKey)) {
    log.problem(
      "remove-api-key",
      `That isn't an api key: a key is ${API_KEY_HEX_DIGITS} lower-case hex characters. Nothing was removed.`,
    );
    return 1;
  }
  log.hide(apiKey);
  const hash = hashApiKey(apiKey);
  if (!keys.records.has(hash)) {
    log.problem(
      "remove-api-key",
      `That api key isn't in ${filePath}. Nothing was removed.`,
    );
    return 1;
  }
  if (keys.records.size === 1 && !(await prompts.ask(LAST_KEY_QUESTION))) {
    log.info("remove-api-key", "Kept, as asked. Nothing was removed.");
    return 1;
  }
  keys.records.delete(hash);
  askSudoFirst(host);
  /*-
   * nginx's list goes first: when a later step fails, the file still
   * holds the key, so running the command again finds it and removes it.
   */
  const total = handListToNginx(run, keys, "remove-api-key");
  try {
    writeHashedApiKeys(host, filePath, keys);
  } catch (error) {
    throw new Error(halfRemoved(filePath, error.message), { cause: error });
  }
  log.info(
    "remove-api-key",
    `Removed the api key ${apiKey}. ${apiKeysCount(total)} left.`,
  );
  return 0;
}

/**
 * Runs remove-api-key.
 * @param {object} run  The run: host, settings, paths, log and prompts.
 * @returns {Promise<number>} The exit code: 1 when nothing was removed.
 * @throws {Error} When apply hasn't set nginx up, there's no file of api
 *   keys, another command holds the api keys' lock, or sudo refuses, each
 *   before it changes anything. Also when one of its two writes fails:
 *   the file still holds the key then, so running it again removes it.
 */
export async function runRemoveApiKey(run) {
  const { host, settings, paths } = run;
  readAppliedState(host, paths.statePath);
  const homeDir = host.homeDir();
  const filePath = hashedApiKeysPathOf(settings, homeDir);
  if (!host.exists(filePath)) {
    throw missingFile(filePath);
  }
  const folder = path.dirname(filePath);
  return withApiKeysLock(host, folder, () => removeUnderLock(run, filePath));
}
