/**
 * @file x1-validator-private-rpc/src/cli/hashed-api-keys.js
 * @description
 * The api keys' records, and nginx's list of their hashes. The tool never
 * keeps an api key itself: it shows each key once, when it makes it, and
 * keeps the key's SHA-256 hash. nginx checks each request by hashing the
 * key the request carries and looking for that hash in its list, so it
 * needs no password, and restarts on its own.
 *
 * hashed-api-keys.json, which the hashedApiKeysPath setting names, holds
 * every hash as a readable json key, so nginx's list and remove-api-key
 * need no password. Its value is the key's record, a json
 * object that can grow: createdAtTimestampMS, the time the key was made,
 * and email, "" when none was given. Every value in a record is encrypted
 * with the x1-validator-services password, as LP Ranger's key store
 * encrypts a private key: AES-256-GCM, with its key from PBKDF2-SHA-512 at
 * 600,000 rounds. The file has one salt, so one opening derives one
 * encryption key, which opens every record, and each value has its own
 * iv. An encrypted value is
 * one string, the iv, GCM's tag and the ciphertext in base64url, joined by
 * dots, and its plain text is the value's json. passwordCheck, a known
 * text encrypted the same way, lets a typed password be checked even when
 * the file holds no record. The file has mode 0600, in a folder with mode
 * 0700, and is written whole to a new file that then replaces the old one.
 *
 * nginx's list, which the hashedApiKeysMapPath setting names, has the
 * form src/lib/key-hash-map.js gives. The tool writes it from the file's
 * hashes, and counts its lines to tell whether nginx holds any key at
 * all. writeMap and ensure-there-is-at-least-one-rpc-api-key share that
 * count.
 *
 * Each command that changes the file or the list holds the api keys'
 * lock, from its read of the file to its last write, so no two of them
 * change the keys at once. add-api-key, remove-api-key and undo-apply's
 * yes get sudo before their first change, so a refused sudo changes
 * nothing.
 * docs/architecture.md says why.
 */

import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { makeApiKey } from "../lib/api-key.js";
import { mustSucceed } from "../lib/command-result.js";
import {
  countMapLines,
  HASH_PATTERN,
  hashApiKey,
  mapText,
} from "../lib/key-hash-map.js";
import { NGINX_UNIT } from "../lib/nginx-org.js";
import { systemctl, unitActiveState } from "../lib/systemd.js";

/** PBKDF2's rounds, as LP Ranger's key store uses. */
export const PBKDF2_ITERATIONS = 600000;

/** What the tool says when nginx's list holds no key. */
export const NO_API_KEY =
  "No api key: nginx refuses every request. Run add-api-key.";

/** What the tool says when a password doesn't open the records. */
export const WRONG_PASSWORD = "The password is wrong, or the file is damaged.";

/** What a command says when another one holds the api keys' lock. */
export const KEYS_LOCKED =
  "Another command is changing the api keys, so this one changed nothing. " +
  "Run it again once that one is done.";

const FORMAT_VERSION = 1;
const PBKDF2_DIGEST = "sha512";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const CIPHER = "aes-256-gcm";

/** The known text that passwordCheck holds, encrypted. */
const PASSWORD_CHECK = "x1-validator-services";

const VALUE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The fields of a record, in the order the file holds them. */
const RECORD_FIELDS = ["createdAtTimestampMS", "email"];

/**
 * @typedef {object} HashedApiKeys
 * @property {{digest: string, iterations: number, saltHex: string}}
 *   kdfParams  How the records' key comes from the password.
 * @property {string} passwordCheck  The known text, encrypted.
 * @property {Map<string, Object<string, string>>} records  Each hash, with
 *   its record's values, encrypted.
 */

/**
 * @typedef {object} ApiKeyRecord
 * @property {number} createdAtTimestampMS  When the key was made, in ms.
 * @property {string} email  The key's email, or "" for none.
 */

/**
 * Makes the records' key from the password, with PBKDF2-SHA-512.
 * @param {string} password  The x1-validator-services password.
 * @param {{iterations: number, saltHex: string}} kdfParams  The salt and
 *   PBKDF2's rounds.
 * @returns {Promise<Buffer>} The key.
 */
function deriveKey(password, { iterations, saltHex }) {
  const pbkdf2 = promisify(crypto.pbkdf2);
  const salt = Buffer.from(saltHex, "hex");
  return pbkdf2(password, salt, iterations, KEY_BYTES, PBKDF2_DIGEST);
}

/**
 * Encrypts one value of a record.
 * @param {Buffer} cipherKey  The records' key.
 * @param {unknown} value  The value, stored as its json.
 * @returns {string} The iv, the tag and the ciphertext, joined by dots.
 */
export function encryptValue(cipherKey, value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, cipherKey, iv);
  const plain = JSON.stringify(value);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const parts = [iv, cipher.getAuthTag(), ciphertext];
  return parts.map((part) => part.toString("base64url")).join(".");
}

/**
 * Decrypts one value of a record.
 * @param {Buffer} cipherKey  The records' key.
 * @param {string} text  The encrypted value.
 * @returns {unknown} The value.
 * @throws {Error} When GCM's check fails, which means a wrong password or
 *   a damaged file.
 */
export function decryptValue(cipherKey, text) {
  const [iv, tag, ciphertext] = text
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  try {
    const decipher = crypto.createDecipheriv(CIPHER, cipherKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch (error) {
    throw new Error(WRONG_PASSWORD, { cause: error });
  }
}

/**
 * Makes a file with no record, for a new password.
 * @param {string} password  The new x1-validator-services password.
 * @param {number} [iterations]  PBKDF2's rounds: PBKDF2_ITERATIONS, unless
 *   a test passes fewer to run fast.
 * @returns {Promise<{keys: HashedApiKeys, cipherKey: Buffer}>} The file,
 *   and the key for its records.
 */
export async function newHashedApiKeys(
  password,
  iterations = PBKDF2_ITERATIONS,
) {
  const kdfParams = {
    digest: PBKDF2_DIGEST,
    iterations,
    saltHex: crypto.randomBytes(SALT_BYTES).toString("hex"),
  };
  const cipherKey = await deriveKey(password, kdfParams);
  const passwordCheck = encryptValue(cipherKey, PASSWORD_CHECK);
  return { keys: { kdfParams, passwordCheck, records: new Map() }, cipherKey };
}

/**
 * Opens a file's records with the password.
 * @param {HashedApiKeys} keys  The file.
 * @param {string} password  The x1-validator-services password.
 * @returns {Promise<Buffer>} The key for its records.
 * @throws {Error} When the password doesn't open passwordCheck, so no
 *   record is ever written under a key the right password can't open.
 */
export async function openHashedApiKeys(keys, password) {
  const cipherKey = await deriveKey(password, keys.kdfParams);
  if (decryptValue(cipherKey, keys.passwordCheck) !== PASSWORD_CHECK) {
    throw new Error(WRONG_PASSWORD);
  }
  return cipherKey;
}

/**
 * Makes a new api key, hides it from the log, and adds its record, made
 * now, with the email given. apply and add-api-key share it.
 * @param {{host: object, log: import("./log.js").Log}} run  The run.
 * @param {HashedApiKeys} keys  The file, which gains the record.
 * @param {Buffer} cipherKey  The records' key.
 * @param {string} email  The key's email, or "" for none.
 * @returns {string} The key, which only its urls show, once.
 */
export function addNewKey({ host, log }, keys, cipherKey, email) {
  const apiKey = makeApiKey();
  log.hide(apiKey);
  const hash = hashApiKey(apiKey);
  const record = { createdAtTimestampMS: host.now(), email };
  addRecord(keys, cipherKey, hash, record);
  return apiKey;
}

/**
 * Adds a key's record, its values encrypted.
 * @param {HashedApiKeys} keys  The file, which gains the record.
 * @param {Buffer} cipherKey  The records' key.
 * @param {string} hash  The key's hash.
 * @param {ApiKeyRecord} record  The record.
 */
export function addRecord(keys, cipherKey, hash, record) {
  const plain = new Map(Object.entries(record));
  const values = RECORD_FIELDS.map((field) => {
    const value = plain.get(field);
    return [field, encryptValue(cipherKey, value)];
  });
  keys.records.set(hash, Object.fromEntries(values));
}

/**
 * Reads a key's record, its values decrypted.
 * @param {HashedApiKeys} keys  The file.
 * @param {Buffer} cipherKey  The records' key.
 * @param {string} hash  The key's hash.
 * @returns {ApiKeyRecord}
 */
export function readRecord(keys, cipherKey, hash) {
  const encrypted = keys.records.get(hash);
  const values = new Map(Object.entries(encrypted));
  const fields = RECORD_FIELDS.map((field) => {
    const text = values.get(field);
    return [field, decryptValue(cipherKey, text)];
  });
  return /** @type {ApiKeyRecord} */ (Object.fromEntries(fields));
}

/**
 * Checks that a parsed file is one this tool writes.
 * @param {unknown} parsed  The parsed json.
 * @returns {boolean}
 */
function isHashedApiKeys(parsed) {
  const records = parsed?.hashedApiKeys;
  if (
    parsed?.version !== FORMAT_VERSION ||
    parsed.kdf !== "pbkdf2" ||
    parsed.kdfParams?.digest !== PBKDF2_DIGEST ||
    !Number.isInteger(parsed.kdfParams.iterations) ||
    typeof parsed.kdfParams.saltHex !== "string" ||
    parsed.cipher !== CIPHER ||
    typeof parsed.passwordCheck !== "string" ||
    !VALUE_PATTERN.test(parsed.passwordCheck) ||
    typeof records !== "object" ||
    records === null ||
    Array.isArray(records)
  ) {
    return false;
  }
  return Object.entries(records).every(
    ([hash, record]) =>
      HASH_PATTERN.test(hash) &&
      typeof record === "object" &&
      record !== null &&
      RECORD_FIELDS.every((field) => {
        const value = new Map(Object.entries(record)).get(field);
        return typeof value === "string" && VALUE_PATTERN.test(value);
      }),
  );
}

/**
 * Reads the file.
 * @param {object} host  The host.
 * @param {string} filePath  The file.
 * @returns {HashedApiKeys|null} The file, or null when there is none yet.
 * @throws {Error} When the file isn't one this tool writes, so a damaged
 *   one is never written over.
 */
export function readHashedApiKeys(host, filePath) {
  if (!host.exists(filePath)) {
    return null;
  }
  let parsed;
  try {
    const text = host.readText(filePath);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} isn't valid json.`, { cause: error });
  }
  if (!isHashedApiKeys(parsed)) {
    throw new Error(`${filePath} isn't a file of api keys this tool wrote.`);
  }
  return {
    kdfParams: parsed.kdfParams,
    passwordCheck: parsed.passwordCheck,
    records: new Map(Object.entries(parsed.hashedApiKeys)),
  };
}

/**
 * Runs a change to the api keys while holding their lock: flock's lock
 * on the folder of hashed-api-keys.json, which the host keeps until the
 * change ends, or until the command ends, even when it's killed.
 * @template T
 * @param {object} host  The host.
 * @param {string} folder  The folder of hashed-api-keys.json, which must
 *   exist.
 * @param {() => Promise<T>} change  The change.
 * @returns {Promise<T>} What the change returns.
 * @throws {Error} When another command holds the lock, before the change
 *   starts, since its change and this one would undo each other.
 */
export async function withApiKeysLock(host, folder, change) {
  const release = host.lockFolder(folder);
  if (release === undefined || release === null) {
    throw new Error(KEYS_LOCKED);
  }
  try {
    return await change();
  } finally {
    release();
  }
}

/**
 * Gets sudo right before a key command's first write, or undo-apply's
 * deletion of the api keys' file after its yes. Writing nginx's list
 * needs sudo, which asks for the account's password unless it asked
 * in that terminal lately. A password typed wrong or cancelled between
 * the command's two writes would leave the api keys' file and nginx's
 * list disagreeing. Asked here, a refusal changes nothing. Asked after the
 * command's own questions, sudo's memory of the password can't run out
 * while the operator takes their time at one.
 * @param {object} host  The host.
 * @throws {Error} When sudo refuses, before anything changes, so the
 *   api keys' file and nginx's list still agree.
 */
export function askSudoFirst(host) {
  const asked = host.sudo("true", []);
  mustSucceed(asked, "Getting sudo before changing anything");
}

/**
 * Writes the file, making its folder first when it's missing.
 * @param {object} host  The host.
 * @param {string} filePath  The file.
 * @param {HashedApiKeys} keys  The file's content.
 */
export function writeHashedApiKeys(host, filePath, keys) {
  const file = {
    version: FORMAT_VERSION,
    kdf: "pbkdf2",
    kdfParams: keys.kdfParams,
    cipher: CIPHER,
    passwordCheck: keys.passwordCheck,
    hashedApiKeys: Object.fromEntries(keys.records),
  };
  host.makeUserDir(path.dirname(filePath), 0o700);
  host.writeUserFile(filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/**
 * Writes nginx's list's text from the file's hashes.
 * @param {HashedApiKeys} keys  The file.
 * @returns {string}
 */
export function keysMapText(keys) {
  return mapText([...keys.records.keys()]);
}

/**
 * Says what's wrong when nginx's list holds no key.
 * @param {number} count  How many keys it holds.
 * @returns {string} NO_API_KEY, or "" when there is a key.
 */
export function noApiKeyProblem(count) {
  return count === 0 ? NO_API_KEY : "";
}

/**
 * Hands nginx its list: writes it from the file's hashes, in one rename,
 * and counts what it wrote.
 * @param {object} host  The host.
 * @param {string} mapPath  nginx's list.
 * @param {HashedApiKeys} keys  The file.
 * @returns {number} How many keys the list holds.
 */
export function writeMap(host, mapPath, keys) {
  const text = keysMapText(keys);
  host.writeRootFile(mapPath, text, "0644");
  return countMapLines(text);
}

/**
 * Hands nginx its list: writes it from the file's hashes, has a running
 * nginx read it again, and says so when the list holds no key, with the
 * same count and words ensure-there-is-at-least-one-rpc-api-key uses.
 * apply, add-api-key and remove-api-key share it.
 * @param {{host: object, settings: object,
 *   log: import("./log.js").Log}} run  The command's run.
 * @param {HashedApiKeys} keys  The file.
 * @param {string} stage  The log's tag.
 * @returns {number} How many keys the list holds.
 */
export function handListToNginx({ host, settings, log }, keys, stage) {
  const count = writeMap(host, settings.hashedApiKeysMapPath, keys);
  reloadNginx(host);
  const problem = noApiKeyProblem(count);
  if (problem !== "") {
    log.problem(stage, problem);
  }
  return count;
}

/**
 * Counts the keys in nginx's list, with no password.
 * @param {object} host  The host.
 * @param {string} mapPath  nginx's list.
 * @returns {number} How many keys it holds, 0 when it's missing.
 */
export function readMapCount(host, mapPath) {
  if (!host.exists(mapPath)) {
    return 0;
  }
  const text = host.readText(mapPath);
  return countMapLines(text);
}

/**
 * Has a running nginx read its configuration again, its list with it.
 * A reload keeps nginx answering throughout.
 * @param {object} host  The host.
 * @returns {boolean} Whether nginx was running, and so reloaded.
 */
export function reloadNginx(host) {
  const running = unitActiveState(host, NGINX_UNIT);
  if (running !== "active") {
    return false;
  }
  systemctl(host, ["reload", NGINX_UNIT]);
  return true;
}

/**
 * Says how many api keys there are, in words.
 * @param {number} count  How many.
 * @returns {string} Such as "1 api key" or "3 api keys".
 */
export function apiKeysCount(count) {
  return `${count} api ${count === 1 ? "key" : "keys"}`;
}

/**
 * Writes an api key's two urls.
 * @param {string} hostname  The rpc's hostname.
 * @param {string} apiKey  The key.
 * @returns {string[]} Its https url, then its websocket url.
 */
export function apiKeyUrls(hostname, apiKey) {
  return [`https://${hostname}/${apiKey}`, `wss://${hostname}/${apiKey}`];
}
