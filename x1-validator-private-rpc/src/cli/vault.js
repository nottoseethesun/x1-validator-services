/**
 * @file x1-validator-private-rpc/src/cli/vault.js
 * @description
 * The vault: secrets encrypted with the x1-validator-services password,
 * in one json file that future validator services can share. Each
 * secret is encrypted the way LP Ranger's command-line version encrypts
 * a private key, in its src/lib/key-store.js, with the same payload
 * fields, so one library could serve every service: AES-256-GCM, with
 * its key from PBKDF2-SHA-512 at 600,000 iterations, and a random 16-byte
 * salt and 12-byte iv for each secret. A wrong password fails the GCM
 * check.
 *
 * The vault file has mode 0600, in a folder with mode 0700. It is
 * written whole to a new file that then replaces the old one, so no
 * reader ever sees it half written.
 */

import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

/** The api key's name in the vault. */
export const API_KEY_SECRET = "x1-validator-private-rpc/api-key";

/** PBKDF2's rounds, as LP Ranger's key store uses. */
export const PBKDF2_ITERATIONS = 600000;

const FORMAT_VERSION = 1;
const PBKDF2_DIGEST = "sha512";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const CIPHER = "aes-256-gcm";

/**
 * @typedef {object} SecretPayload
 * @property {number} version  The payload's format, 1.
 * @property {string} kdf  `pbkdf2`.
 * @property {{digest: string, iterations: number, saltHex: string}}
 *   kdfParams  How the cipher's key comes from the password.
 * @property {string} cipher  `aes-256-gcm`.
 * @property {string} ivHex  The iv.
 * @property {string} authTagHex  GCM's tag.
 * @property {string} ciphertextHex  The encrypted secret.
 */

/**
 * Makes the cipher's key from the password, with PBKDF2-SHA-512.
 * @param {string} password  The x1-validator-services password.
 * @param {Buffer} salt  The secret's salt.
 * @param {number} iterations  PBKDF2's rounds.
 * @returns {Promise<Buffer>} The key.
 */
function deriveKey(password, salt, iterations) {
  const pbkdf2 = promisify(crypto.pbkdf2);
  return pbkdf2(password, salt, iterations, KEY_BYTES, PBKDF2_DIGEST);
}

/**
 * Encrypts one secret with the password.
 * @param {string} plain  The secret.
 * @param {string} password  The x1-validator-services password.
 * @param {number} [iterations]  PBKDF2's rounds: PBKDF2_ITERATIONS,
 *   unless a test passes fewer to run fast.
 * @returns {Promise<SecretPayload>}
 */
export async function encryptSecret(
  plain,
  password,
  iterations = PBKDF2_ITERATIONS,
) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, iterations);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return {
    version: FORMAT_VERSION,
    kdf: "pbkdf2",
    kdfParams: {
      digest: PBKDF2_DIGEST,
      iterations,
      saltHex: salt.toString("hex"),
    },
    cipher: CIPHER,
    ivHex: iv.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
  };
}

/**
 * Decrypts one secret with the password.
 * @param {SecretPayload} payload  The encrypted secret.
 * @param {string} password  The x1-validator-services password.
 * @returns {Promise<string>} The secret.
 * @throws {Error} When the payload isn't in the format this tool writes,
 *   so no other cipher is ever used; or when GCM's check fails, which
 *   means a wrong password or a damaged vault.
 */
export async function decryptSecret(payload, password) {
  if (
    payload?.version !== FORMAT_VERSION ||
    payload.kdf !== "pbkdf2" ||
    payload.kdfParams?.digest !== PBKDF2_DIGEST ||
    payload.cipher !== CIPHER
  ) {
    throw new Error(
      "The vault holds a secret in a format this tool can't read.",
    );
  }
  const salt = Buffer.from(payload.kdfParams.saltHex, "hex");
  const key = await deriveKey(password, salt, payload.kdfParams.iterations);
  const decipher = crypto.createDecipheriv(
    CIPHER,
    key,
    Buffer.from(payload.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTagHex, "hex"));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertextHex, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch (error) {
    throw new Error("The password is wrong, or the vault is damaged.", {
      cause: error,
    });
  }
}

/**
 * Makes a vault with no secrets in it.
 * @returns {{version: number, secrets: Object<string, SecretPayload>}}
 */
export function emptyVault() {
  return { version: FORMAT_VERSION, secrets: {} };
}

/**
 * Reads the vault.
 * @param {object} host  The host.
 * @param {string} vaultPath  The vault's file.
 * @returns {{version: number, secrets: Object<string, SecretPayload>}|null}
 *   The vault, or null when there is none yet.
 * @throws {Error} When the file isn't a vault, so a damaged one is never
 *   written over.
 */
export function readVault(host, vaultPath) {
  if (!host.exists(vaultPath)) {
    return null;
  }
  let vault;
  try {
    const text = host.readText(vaultPath);
    vault = JSON.parse(text);
  } catch (error) {
    throw new Error(`${vaultPath} isn't valid json.`, { cause: error });
  }
  const secrets = vault?.secrets;
  if (
    vault?.version !== FORMAT_VERSION ||
    typeof secrets !== "object" ||
    secrets === null ||
    Array.isArray(secrets)
  ) {
    throw new Error(`${vaultPath} isn't a vault this tool can read.`);
  }
  return vault;
}

/**
 * Writes the vault, making its folder first when it's missing.
 * @param {object} host  The host.
 * @param {string} vaultPath  The vault's file.
 * @param {{version: number, secrets: Object<string, SecretPayload>}} vault
 *   The vault.
 */
export function writeVault(host, vaultPath, vault) {
  host.makeUserDir(path.dirname(vaultPath), 0o700);
  host.writeUserFile(vaultPath, `${JSON.stringify(vault, null, 2)}\n`, 0o600);
}

/**
 * Finds one secret in the vault.
 * @param {{secrets: Object<string, SecretPayload>}|null} vault  The vault,
 *   or null when there is none.
 * @param {string} name  The secret's name, such as API_KEY_SECRET.
 * @returns {SecretPayload|undefined}
 */
export function secretOf(vault, name) {
  return new Map(Object.entries(vault?.secrets ?? {})).get(name);
}

/**
 * Makes a copy of the vault with one secret added or replaced.
 * @param {{version: number, secrets: Object<string, SecretPayload>}} vault
 *   The vault.
 * @param {string} name  The secret's name.
 * @param {SecretPayload} payload  The encrypted secret.
 * @returns {{version: number, secrets: Object<string, SecretPayload>}}
 */
export function withSecret(vault, name, payload) {
  return { ...vault, secrets: { ...vault.secrets, [name]: payload } };
}

/**
 * Makes a copy of the vault without one secret.
 * @param {{version: number, secrets: Object<string, SecretPayload>}} vault
 *   The vault.
 * @param {string} name  The secret's name.
 * @returns {{version: number, secrets: Object<string, SecretPayload>}}
 */
export function withoutSecret(vault, name) {
  const secrets = Object.fromEntries(
    Object.entries(vault.secrets).filter(([other]) => other !== name),
  );
  return { ...vault, secrets };
}
