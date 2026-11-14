/**
 * @file x1-validator-private-rpc/src/cli/apply-key.js
 * @description
 * apply's fourth stage: the api key and the password. With no key in the
 * vault yet, it makes one, in the format src/lib/api-key.js gives, and
 * stores it encrypted with the x1-validator-services password: a new
 * one, typed twice, or the existing one when the vault already holds
 * other secrets. An existing key is kept; it only asks for the password
 * to read it, since nginx needs the key at its start.
 *
 * Then it offers to save the password with systemd's encrypted
 * credentials, so nginx unlocks itself after a restart, showing first
 * what systemd said about a TPM2 chip and what that means. The question
 * is asked even with --yes, which skips only confirmations. It makes the
 * saved password's folder only when the folder is missing, so a folder
 * that was there keeps its own mode.
 */

import path from "node:path";
import { makeApiKey } from "../lib/api-key.js";
import { mustSucceed } from "../lib/command-result.js";
import { PASSWORD_CREDENTIAL } from "../lib/render-host-files.js";
import { homePath } from "./feature-paths.js";
import {
  API_KEY_SECRET,
  decryptSecret,
  emptyVault,
  encryptSecret,
  readVault,
  secretOf,
  withSecret,
  writeVault,
} from "./vault.js";
import { foldersToMake, found, made } from "./what-apply-changed.js";

/**
 * Explains systemd's answer about a TPM2 chip, for the save question.
 * @param {string} answer  `systemd-creds has-tpm2`'s output.
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
      "Install libtss2-esys-3.0.2-0t64, libtss2-mu-4.0.1-0t64 and " +
      "libtss2-rc0t64, then run apply again before saving."
    );
  }
  return (
    "This machine has no usable TPM2 chip, so a saved password rests on a " +
    "key on the same disk: anyone with a copy of the disk could decrypt " +
    "it. Save it only if that risk is acceptable. Otherwise, run unlock " +
    "after each restart of nginx."
  );
}

/**
 * Asks for the password once, and decrypts a secret with it.
 * @param {object} prompts  The run's prompts.
 * @param {object} payload  A secret the password must decrypt.
 * @returns {Promise<{password: string, plain: string}>}
 * @throws {Error} When the password is wrong.
 */
async function tryPassword(prompts, payload) {
  const password = await prompts.password("x1-validator-services password: ");
  return { password, plain: await decryptSecret(payload, password) };
}

/**
 * Asks for the password until it decrypts a secret, as many times as the
 * settings allow.
 * @param {object} prompts  The run's prompts.
 * @param {object} payload  A secret the password must decrypt.
 * @param {number} tries  How many times it may be typed.
 * @returns {Promise<{password: string, plain: string}>}
 * @throws {Error} After the last wrong try, since nothing can go on
 *   without the secret, and endless tries would invite guessing.
 */
export async function askKnownPassword(prompts, payload, tries) {
  for (let left = tries; left > 1; left--) {
    try {
      return await tryPassword(prompts, payload);
    } catch (error) {
      prompts.say(`${error.message} ${left - 1} more tries.`);
    }
  }
  return tryPassword(prompts, payload);
}

/**
 * Asks for a new password, twice, until both match and it's long enough.
 * @param {object} prompts  The run's prompts.
 * @param {{passwordMinLength: number, passwordTries: number}} settings
 *   The fewest characters the password may have, and how many times it
 *   may be typed.
 * @returns {Promise<string>}
 * @throws {Error} After the last failed try, since no vault can be made
 *   without a password that's long enough and typed the same twice.
 */
export async function askNewPassword(prompts, settings) {
  const { passwordMinLength, passwordTries } = settings;
  for (let left = passwordTries; left > 0; left--) {
    const first = await prompts.password(
      "A new x1-validator-services password: ",
    );
    const second = await prompts.password("The same password again: ");
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
 * Makes the api key and stores it in the vault, with the password.
 * @param {object} context  The run.
 * @param {object|null} vault  The vault, or null when there is none.
 * @param {string} vaultPath  The vault's file.
 * @returns {Promise<{key: string, password: string}>}
 */
async function storeNewKey(context, vault, vaultPath) {
  const { prompts, record, settings } = context;
  const others = Object.values(vault?.secrets ?? {}).filter(
    (payload) => payload !== undefined && payload !== null,
  );
  const password =
    others.length > 0
      ? (await askKnownPassword(prompts, others[0], settings.passwordTries))
          .password
      : await askNewPassword(prompts, settings);
  const key = makeApiKey();
  const payload = await encryptSecret(key, password);
  const updated = withSecret(vault ?? emptyVault(), API_KEY_SECRET, payload);
  const folders = foldersToMake(context.host, path.dirname(vaultPath));
  for (const folder of folders) {
    record(made(`vaultFolder:${folder}`));
  }
  writeVault(context.host, vaultPath, updated);
  const vaultKey = `vault:${vaultPath}`;
  record(vault === null ? made(vaultKey) : found(vaultKey));
  record(made(`apiKey:${vaultPath}`));
  return { key, password };
}

/**
 * Reads the api key the vault holds, with the password.
 * @param {object} context  The run.
 * @param {object} stored  The key, encrypted.
 * @param {string} vaultPath  The vault's file.
 * @returns {Promise<{key: string, password: string}>}
 */
async function readStoredKey(context, stored, vaultPath) {
  const { prompts, record, settings } = context;
  const known = await askKnownPassword(prompts, stored, settings.passwordTries);
  record(found(`vault:${vaultPath}`));
  record(found(`apiKey:${vaultPath}`));
  return { key: known.plain, password: known.password };
}

/**
 * Saves the password with systemd's encrypted credentials. Root looks
 * for the folder, since a parent may be root's alone.
 * @param {object} context  The run.
 * @param {string} password  The password.
 */
function savePassword(context, password) {
  const { host, settings, record } = context;
  const target = settings.passwordCredentialPath;
  const folder = path.dirname(target);
  const looked = host.sudo("test", ["-e", folder]);
  if (looked.status !== 0) {
    record(made(`savedPasswordFolder:${folder}`));
    const created = host.sudo("install", ["-d", "-m", "0700", "--", folder]);
    mustSucceed(created, `Creating ${folder}`);
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
 * Runs the stage.
 * @param {object} context  The run.
 * @returns {Promise<{key: string|null, saved: boolean}>} The api key,
 *   null in a dry run; and whether the password is saved.
 */
export async function setUpKey(context) {
  const { host, settings, prompts, facts, log, record } = context;
  const homeDir = host.homeDir();
  const vaultPath = homePath(settings.vaultPath, homeDir);
  // Root looks, since the saved password's folder is root's alone.
  const looked = host.sudo("test", ["-e", settings.passwordCredentialPath]);
  const alreadySaved = looked.status === 0;
  if (context.dryRun) {
    log.info("key", `Would read or make the api key in ${vaultPath}.`);
    return { key: null, saved: alreadySaved };
  }
  const vault = readVault(host, vaultPath);
  const stored = secretOf(vault, API_KEY_SECRET);
  const { key, password } =
    stored === undefined || stored === null
      ? await storeNewKey(context, vault, vaultPath)
      : await readStoredKey(context, stored, vaultPath);
  log.hide(key);
  if (alreadySaved) {
    log.info("key", "The password is saved already.");
    record(found(`savedPassword:${settings.passwordCredentialPath}`));
    return { key, saved: true };
  }
  log.info("key", explainTpm2(facts.tpm2));
  const save = await prompts.ask(
    "Save the password, so nginx unlocks itself after a restart?",
  );
  if (save) {
    savePassword(context, password);
  }
  return { key, saved: save };
}
