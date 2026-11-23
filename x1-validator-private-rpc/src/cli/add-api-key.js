/**
 * @file x1-validator-private-rpc/src/cli/add-api-key.js
 * @description
 * The `add-api-key` command: it makes new api keys, adds their records
 * to hashed-api-keys.json, and hands nginx the new list of hashes. It
 * asks for the x1-validator-services password, since each record's
 * values are encrypted with it. Once the file holds the new keys, it
 * shows each key's urls, the only time the tool ever shows a key. The
 * urls name the hostname nginx serves, as apply set it up, which the
 * tool's state holds.
 *
 * --count makes several keys at once. commander checks it with the
 * parser below, so a bad count is refused before the disclaimer. After
 * the password, the command asks for an email for the new keys, which
 * must have the form the schema asks of acmeEmail, and asks again until
 * it has one. Enter gives none, and a key's email is then "". It asks at
 * a prompt, never as an option, so the email stays out of the shell's
 * history and out of ps. The command refuses to go past maxApiKeys, and
 * to run before apply has made the first key and set nginx up. It holds
 * the api keys' lock from its read of the file to its last write. It
 * gets sudo, which writing nginx's list needs, after its questions and
 * before its first write, so a refused sudo changes nothing.
 */

import path from "node:path";
import { InvalidArgumentError } from "commander";
import { isEmail } from "../lib/settings.js";
import { askKnownPassword } from "./apply-key.js";
import { hashedApiKeysPathOf } from "./feature-paths.js";
import {
  addNewKey,
  apiKeysCount,
  apiKeyUrls,
  askSudoFirst,
  handListToNginx,
  readHashedApiKeys,
  withApiKeysLock,
  writeHashedApiKeys,
} from "./hashed-api-keys.js";
import { readAppliedState } from "./state.js";

/** The form --count takes: a whole number, 1 or more. */
const COUNT_PATTERN = /^[1-9][0-9]*$/;

/** The prompt for the new keys' one email, which shows what's typed. */
export const EMAIL_PROMPT =
  "One email for every api key this run makes, or Enter for none: ";

/** What the command says before it asks for the email again. */
export const NOT_AN_EMAIL = "That isn't an email address.";

/**
 * Reads --count, for commander.
 * @param {string} value  The option's value.
 * @returns {number}
 * @throws {InvalidArgumentError} When it isn't a whole number of 1 or
 *   more, so commander names the option and refuses it.
 */
export function parseCount(value) {
  if (!COUNT_PATTERN.test(value)) {
    throw new InvalidArgumentError("It must be a whole number, 1 or more.");
  }
  return Number(value);
}

/**
 * Asks for the new keys' email, until the answer is one, or nothing.
 * @param {object} prompts  The run's prompts.
 * @returns {Promise<string>} The email, or "" for none.
 */
async function askEmail(prompts) {
  const answer = await prompts.line(EMAIL_PROMPT);
  const email = answer.trim();
  if (email === "" || isEmail(email)) {
    return email;
  }
  prompts.say(NOT_AN_EMAIL);
  return askEmail(prompts);
}

/**
 * Says the file is missing, so there's nothing to add keys to.
 * @param {string} filePath  The file.
 * @returns {Error}
 */
function missingFile(filePath) {
  return new Error(`${filePath} is missing. Run apply, which makes it.`);
}

/**
 * Adds the keys, while the caller holds the api keys' lock.
 * @param {object} run  The run.
 * @param {string} filePath  The file.
 * @param {string} hostname  The hostname nginx serves.
 * @returns {Promise<number>} The exit code.
 */
async function addUnderLock(run, filePath, hostname) {
  const { host, settings, log, prompts, out } = run;
  const { count } = run.options;
  const keys = readHashedApiKeys(host, filePath);
  if (keys === undefined || keys === null) {
    throw missingFile(filePath);
  }
  const room = settings.maxApiKeys - keys.records.size;
  if (count > room) {
    throw new Error(
      `${filePath} holds ${apiKeysCount(keys.records.size)}, and ` +
        `maxApiKeys is ${settings.maxApiKeys}, so ${room} more fit, not ${count}.`,
    );
  }
  const tries = settings.passwordTries;
  const { cipherKey } = await askKnownPassword(prompts, keys, tries);
  const email = await askEmail(prompts);
  const made = Array.from({ length: count }, () =>
    addNewKey(run, keys, cipherKey, email),
  );
  askSudoFirst(host);
  writeHashedApiKeys(host, filePath, keys);
  log.info("add-api-key", `Made ${apiKeysCount(count)}. The urls, shown once:`);
  for (const apiKey of made) {
    for (const url of apiKeyUrls(hostname, apiKey)) {
      out(url);
    }
  }
  log.info(
    "add-api-key",
    "Save these urls now, off the validator. The client needs them, and " +
      "so do you, to remove a key later. The tool stores only each key's " +
      "hash, so no command can show a key again.",
  );
  const total = handListToNginx(run, keys, "add-api-key");
  log.info("add-api-key", `${apiKeysCount(total)} in all.`);
  return 0;
}

/**
 * Runs add-api-key.
 * @param {object} run  The run: host, settings, paths, log, prompts, out,
 *   and options {count}, which commander has checked.
 * @returns {Promise<number>} The exit code.
 * @throws {Error} When apply hasn't set nginx up, there's no file of api
 *   keys, another command holds the api keys' lock, the new keys would
 *   pass maxApiKeys, the password is wrong, or sudo refuses, each before
 *   it changes anything, so the operator can put it right and run it
 *   again.
 */
export async function runAddApiKey(run) {
  const { host, settings, paths } = run;
  const { setup } = readAppliedState(host, paths.statePath);
  const homeDir = host.homeDir();
  const filePath = hashedApiKeysPathOf(settings, homeDir);
  if (!host.exists(filePath)) {
    throw missingFile(filePath);
  }
  const folder = path.dirname(filePath);
  return withApiKeysLock(host, folder, () =>
    addUnderLock(run, filePath, setup.hostname),
  );
}
