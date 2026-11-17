/**
 * @file x1-validator-private-rpc/src/cli/apply-key.js
 * @description
 * apply's fourth stage: the api keys and the password. The tool never
 * keeps an api key itself: hashed-api-keys.js keeps each key's hash, with
 * a record whose values the x1-validator-services password encrypts.
 *
 * With no record yet, the stage makes the first key. It asks for the
 * password, a new one, typed twice, when there's no file yet. It makes
 * the key, in the format src/lib/api-key.js gives, adds its record and
 * writes the file. At once it shows the key's urls in full, the only time
 * the tool ever shows the key, so the operator sees it even if the run
 * stops later. Then it writes nginx's list, and has a running nginx read
 * it again. With records there already, the stage writes nginx's list
 * again only when the list differs from the file's hashes. It asks
 * nothing then, unless the saved password is marked stale, as below.
 *
 * With the password in hand, the stage offers to save it with systemd's
 * encrypted credentials, so the tool can read the records unattended. It
 * shows first what systemd said about a TPM2 chip and what that means.
 * The question is asked even with --yes, which skips only confirmations.
 * A password saved for an earlier file can't open a new one. So when the
 * stage makes a new file while a password is saved, it asks again, and
 * writes the new password over the old one, or removes the old one on a
 * no. Before it asks, it writes into the tool's state that the saved
 * password is stale, so a run that ends before the answer leaves the next
 * run asking again, not taking the old password as saved. It makes the
 * saved password's folder only when the folder is missing, so a folder
 * that was there keeps its own mode.
 *
 * The stage holds the api keys' lock from its read of the file to its
 * last write, as add-api-key, remove-api-key and undo-apply do. The lock
 * is on the file's folder, so the stage makes that folder first, and
 * records it, before it takes the lock.
 *
 * The stage hands the next one the key it made, or "" when it made none.
 * The next stage checks what it gets with checkedKey before it uses it.
 */

import path from "node:path";
import { isApiKey } from "../lib/api-key.js";
import { mustSucceed } from "../lib/command-result.js";
import { foldersToMake, rootLooks } from "../lib/folders-to-make.js";
import { hashedApiKeysPathOf } from "./feature-paths.js";
import {
  addNewKey,
  apiKeysCount,
  apiKeyUrls,
  handListToNginx,
  keysMapText,
  newHashedApiKeys,
  openHashedApiKeys,
  readHashedApiKeys,
  withApiKeysLock,
  writeHashedApiKeys,
} from "./hashed-api-keys.js";
import { writeState } from "./state.js";
import { found, made, recordFoldersMade } from "./what-apply-changed.js";

/** The name systemd keeps the saved password under. */
export const PASSWORD_CREDENTIAL = "x1-validator-services-password";

/** What the stage says beside the first key's urls. */
export const SAVE_THE_KEY =
  "Save it now: the tool keeps only its hash, and can't show it again.";

/** The prompt for the x1-validator-services password. */
export const PASSWORD_PROMPT = "x1-validator-services password: ";

/** The two prompts for a new password, which is typed twice. */
export const NEW_PASSWORD_PROMPT = "A new x1-validator-services password: ";
export const SAME_PASSWORD_PROMPT = "The same password again: ";

/** The question that offers to save the password. */
export const SAVE_PASSWORD_QUESTION =
  "Save the password, so the tool can read the api keys' records " +
  "unattended, for the rotation notices and billing to come?";

/**
 * Explains systemd's answer about a TPM2 chip, for the save question.
 * @param {string} answer  The output of `has-tpm2`, from `systemd-analyze`
 *   or, on an older systemd, from `systemd-creds`.
 * @returns {string}
 */
export function explainTpm2(answer) {
  const lines = answer.split("\n").map((line) => line.trim());
  const missing = lines.filter((line) => line.startsWith("-"));
  if (lines[0] === "yes") {
    return (
      "systemd can use this machine's TPM2 chip, so a saved password is " +
      "tied to the chip: a copied disk alone doesn't give it up."
    );
  }
  if (lines[0] === "partial" && missing.join() === "-libraries") {
    return (
      "This machine's TPM2 chip works, but systemd lacks its libraries. " +
      "To tie a saved password to the chip, install " +
      "libtss2-esys-3.0.2-0t64, libtss2-mu-4.0.1-0t64 and libtss2-rc0t64 " +
      "in another terminal before you answer, since apply asks this only " +
      "once."
    );
  }
  return (
    "This machine has no usable TPM2 chip, so a saved password rests on a " +
    "key on the same disk: anyone with a copy of the disk could decrypt " +
    "it. Save it only if that risk is acceptable."
  );
}

/**
 * Asks for the password once, and opens the records with it.
 * @param {object} prompts  The run's prompts.
 * @param {import("./hashed-api-keys.js").HashedApiKeys} keys  The file.
 * @returns {Promise<{password: string, cipherKey: Buffer}>}
 * @throws {Error} When the password is wrong, so the caller can count
 *   the try and ask again.
 */
async function tryPassword(prompts, keys) {
  const password = await prompts.password(PASSWORD_PROMPT);
  return { password, cipherKey: await openHashedApiKeys(keys, password) };
}

/**
 * Asks for the password until it opens the records, as many times as the
 * settings allow.
 * @param {object} prompts  The run's prompts.
 * @param {import("./hashed-api-keys.js").HashedApiKeys} keys  The file.
 * @param {number} tries  How many times it may be typed.
 * @returns {Promise<{password: string, cipherKey: Buffer}>}
 * @throws {Error} After the last wrong try, since nothing can go on
 *   without the records, and endless tries would invite guessing.
 */
export async function askKnownPassword(prompts, keys, tries) {
  for (let left = tries; left > 1; left--) {
    try {
      return await tryPassword(prompts, keys);
    } catch (error) {
      prompts.say(`${error.message} ${left - 1} more tries.`);
    }
  }
  return tryPassword(prompts, keys);
}

/**
 * Asks for a new password, twice, until both match and it's long enough.
 * @param {object} prompts  The run's prompts.
 * @param {{passwordMinLength: number, passwordTries: number}} settings
 *   The fewest characters the password may have, and how many times it
 *   may be typed.
 * @returns {Promise<string>}
 * @throws {Error} After the last failed try, since no api keys' file can
 *   be made without a password that's long enough and typed the same
 *   twice.
 */
export async function askNewPassword(prompts, settings) {
  const { passwordMinLength, passwordTries } = settings;
  for (let left = passwordTries; left > 0; left--) {
    const first = await prompts.password(NEW_PASSWORD_PROMPT);
    const second = await prompts.password(SAME_PASSWORD_PROMPT);
    if (first.length >= passwordMinLength && first === second) {
      return first;
    }
    prompts.say(
      first === second
        ? `The password must have at least ${passwordMinLength} characters.`
        : "The two passwords differ.",
    );
  }
  throw new Error("No usable password was typed.");
}

/**
 * Hands nginx the file's hashes when its list differs from them. Before
 * the write, it records the list and each folder the write makes, as
 * nginx's files' folders, so undo-apply removes them. A record of a file
 * the write then failed to make does no harm: removing it removes
 * nothing.
 * @param {object} context  The run.
 * @param {import("./hashed-api-keys.js").HashedApiKeys} keys  The file.
 */
function publishHashes(context, keys) {
  const { host, settings, record } = context;
  const mapPath = settings.hashedApiKeysMapPath;
  const key = `hashedApiKeysMapFile:${mapPath}`;
  const there = host.exists(mapPath);
  if (there === true && host.readText(mapPath) === keysMapText(keys)) {
    record(found(key));
    return;
  }
  const folders = foldersToMake(host, path.dirname(mapPath));
  recordFoldersMade(record, "nginxFileFolder", folders);
  record(there === true ? found(key) : made(key));
  handListToNginx(context, keys, "keys");
}

/**
 * Makes the first api key: asks the password, adds the key's record and
 * writes the file. Then it shows the key's urls, once the file holds the
 * key, and before anything else can stop the run, and last writes
 * nginx's list.
 * @param {object} context  The run.
 * @param {import("./hashed-api-keys.js").HashedApiKeys|null} keys  The
 *   file, or null when there is none yet.
 * @param {string} filePath  The file.
 * @returns {Promise<{apiKey: string, password: string, fresh: boolean}>}
 *   The key, the password, and whether this run made the file.
 */
async function makeFirstKey(context, keys, filePath) {
  const { host, prompts, settings, log, out } = context;
  const fresh = keys === undefined || keys === null;
  const opened =
    fresh === true
      ? await newFileWithPassword(prompts, settings)
      : {
          keys,
          ...(await askKnownPassword(prompts, keys, settings.passwordTries)),
        };
  const apiKey = addNewKey(context, opened.keys, opened.cipherKey, "");
  writeHashedApiKeys(host, filePath, opened.keys);
  log.info("keys", "Made the first api key. Its urls, shown this once:");
  for (const url of apiKeyUrls(settings.hostname, apiKey)) {
    out(url);
  }
  log.info("keys", SAVE_THE_KEY);
  publishHashes(context, opened.keys);
  return { apiKey, password: opened.password, fresh };
}

/**
 * Asks for a new password, and makes a new api keys' file for it.
 * @param {object} prompts  The run's prompts.
 * @param {object} settings  The tool's settings.
 * @returns {Promise<{keys: object, cipherKey: Buffer, password: string}>}
 */
async function newFileWithPassword(prompts, settings) {
  const password = await askNewPassword(prompts, settings);
  return { ...(await newHashedApiKeys(password)), password };
}

/**
 * Saves the password with systemd's encrypted credentials. Root looks
 * for each folder, since a parent may be root's alone. Making the folder
 * makes every missing one above it too, and each is recorded, so
 * undo-apply removes it once it's empty.
 * @param {object} context  The run.
 * @param {string} password  The password.
 */
function savePassword(context, password) {
  const { host, settings, record } = context;
  const target = settings.passwordCredentialPath;
  const folder = path.dirname(target);
  const asRoot = rootLooks(host);
  const missing = foldersToMake(asRoot, folder);
  recordFoldersMade(record, "savedPasswordFolder", missing);
  if (missing.length > 0) {
    host.makeRootDir(folder, "0700");
  }
  const encrypted = host.sudo(
    "systemd-creds",
    ["encrypt", `--name=${PASSWORD_CREDENTIAL}`, "-", target],
    { input: password },
  );
  mustSucceed(encrypted, `Saving the password to ${target}`);
  record(made(`savedPassword:${target}`));
}

/**
 * Removes a saved password that opens an earlier file, not this one.
 * @param {object} context  The run.
 */
function removeOldPassword(context) {
  const { host, settings, record, log } = context;
  const target = settings.passwordCredentialPath;
  record({ key: `savedPassword:${target}`, oldValue: true, newValue: false });
  host.removeRootFile(target);
  log.info("keys", `Removed the old saved password, ${target}.`);
}

/**
 * Offers to save the password, now that the stage has it: says it's
 * saved already when it is and still opens the file, or asks.
 * @param {object} context  The run.
 * @param {string} password  The password.
 * @param {{saved: boolean, stale: boolean}} existing  Whether a password
 *   is saved, and whether it's left from an earlier file.
 * @returns {Promise<void>}
 */
async function offerToSavePassword(context, password, existing) {
  const { host, settings, paths, prompts, facts, log, record, state } = context;
  if (existing.saved === true && existing.stale === false) {
    log.info("keys", "The password is saved already.");
    record(found(`savedPassword:${settings.passwordCredentialPath}`));
    return;
  }
  if (existing.stale === true) {
    /*-
     * Written now, before the question, so a run that ends before it's
     * answered leaves apply knowing there's no usable saved password.
     */
    state.savedPasswordStale = true;
    writeState(host, paths.statePath, state);
    log.info(
      "keys",
      "The saved password is for an earlier file of api keys, and can't " +
        "open this one.",
    );
  }
  log.info("keys", explainTpm2(facts.tpm2));
  const save = await prompts.ask(SAVE_PASSWORD_QUESTION);
  if (save === true) {
    savePassword(context, password);
  } else if (existing.saved === true) {
    removeOldPassword(context);
  }
  clearStaleMark(context);
}

/**
 * Clears the stale mark once the save question is answered, on disk too,
 * since the run's own write of the state only follows a change in it.
 * @param {object} context  The run.
 */
function clearStaleMark({ host, paths, state }) {
  if (state.savedPasswordStale === true) {
    state.savedPasswordStale = false;
    writeState(host, paths.statePath, state);
  }
}

/**
 * Counts a file's records.
 * @param {import("./hashed-api-keys.js").HashedApiKeys|null} keys  The
 *   file, or null when there is none.
 * @returns {number}
 */
function recordCount(keys) {
  return keys === undefined || keys === null ? 0 : keys.records.size;
}

/**
 * Checks the api key the stage handed on, where a later stage takes it
 * up. The stage hands on the key it made, or "" when it made none, so
 * anything else is a mistake in the tool, which stops the run.
 * @param {unknown} key  What the stage handed on.
 * @returns {string} The key, or "".
 * @throws {Error} When the key is undefined, isn't a string, or is
 *   neither "" nor an api key, since a later stage would otherwise check
 *   the request path with a wrong key.
 */
export function checkedKey(key) {
  if (key === undefined) {
    throw new Error('The api keys\' stage handed on no key, not even "".');
  }
  if (typeof key !== "string") {
    throw new Error("The api keys' stage handed on something not a string.");
  }
  if (key !== "" && !isApiKey(key)) {
    throw new Error("The api keys' stage handed on text that isn't a key.");
  }
  return key;
}

/**
 * Hands nginx the keys there are, or makes the first one, and offers to
 * save the password. The caller holds the api keys' lock.
 * @param {object} context  The run.
 * @param {string} filePath  The file.
 * @param {boolean} saved  Whether a password is saved.
 * @returns {Promise<{key: string}>} The api key this run made, or "".
 */
async function keysUnderLock(context, filePath, saved) {
  const { host, settings, prompts, log, state } = context;
  const keys = readHashedApiKeys(host, filePath);
  const count = recordCount(keys);
  if (count > 0) {
    publishHashes(context, keys);
    log.info("keys", `${filePath} holds ${apiKeysCount(count)} already.`);
    if (saved === true && state.savedPasswordStale === true) {
      const tries = settings.passwordTries;
      const { password } = await askKnownPassword(prompts, keys, tries);
      await offerToSavePassword(context, password, { saved, stale: true });
    }
    clearStaleMark(context);
    return { key: "" };
  }
  const first = await makeFirstKey(context, keys, filePath);
  const stale =
    saved === true &&
    (first.fresh === true || state.savedPasswordStale === true);
  await offerToSavePassword(context, first.password, { saved, stale });
  return { key: first.apiKey };
}

/**
 * Runs the stage.
 * @param {object} context  The run.
 * @returns {Promise<{key: string}>} The api key this run made, for the
 *   fifth stage's check of the request path, or "" when it made none.
 */
export async function setUpApiKeys(context) {
  const { host, settings, log } = context;
  const homeDir = host.homeDir();
  const filePath = hashedApiKeysPathOf(settings, homeDir);
  // Root looks, since the saved password's folder is root's alone.
  const asRoot = rootLooks(host);
  const saved = asRoot.exists(settings.passwordCredentialPath);
  if (context.dryRun === true) {
    const keys = readHashedApiKeys(host, filePath);
    const count = recordCount(keys);
    log.info(
      "keys",
      count === 0
        ? `Would make the first api key, and its record in ${filePath}.`
        : `Would hand nginx the hashes of the ${apiKeysCount(count)} in ${filePath}.`,
    );
    return { key: "" };
  }
  const folder = path.dirname(filePath);
  const missing = foldersToMake(host, folder);
  recordFoldersMade(context.record, "hashedApiKeysFolder", missing);
  if (missing.length > 0) {
    host.makeUserDir(folder, 0o700);
  }
  return withApiKeysLock(host, folder, () =>
    keysUnderLock(context, filePath, saved),
  );
}
