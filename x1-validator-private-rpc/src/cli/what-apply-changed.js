/**
 * @file x1-validator-private-rpc/src/cli/what-apply-changed.js
 * @description
 * apply's record of the settings it changed on the machine, or found as
 * it needed them: `app-data/what-apply-changed.json`. undo-apply resets
 * each setting apply changed to its old value, newest first, and deletes
 * the record once nothing is left in it.
 *
 * Each key names one setting, by its name in the shipped dictionary,
 * `apply-settings-dictionary.json`. A setting that applies to one file,
 * folder, package, rule or crontab line adds `:` and that target, such
 * as `nginxConfigFile:/etc/nginx/x1-validator-private-rpc/nginx.conf`.
 * Each holds:
 *
 * - `description`: what the setting is, from the dictionary.
 * - `applyChangedThisFromItsPreviousValue`: whether apply changed it, or
 *   found it already as it needed it and left it.
 * - `applyChangedThisValueAtThisTimestampMS`: when apply changed it, in
 *   milliseconds since 1970; -1 when apply never changed it. It's always
 *   there, so an entry without it is a damaged one.
 * - `oldValue`: its value before apply, as text.
 * - `oldValueDatatype`: how to read the old value, from the dictionary:
 *   `string`, `integer` or `boolean`.
 *
 * Whether a file, a folder, a package, an account, a firewall rule or a
 * crontab line is there is a boolean setting.
 *
 * A setting is recorded the moment apply changes it, so a stage that
 * fails part way still leaves an exact record. A later apply finds its
 * own changes in place, and never writes over an entry that says apply
 * changed the setting, so the old value stays the one from before the
 * first apply.
 */

import path from "node:path";
import { readJson, shippedDefaultsDir } from "../lib/settings.js";

/**
 * @typedef {object} Entry  One setting, as the record keeps it.
 * @property {string} description  What the setting is.
 * @property {boolean} applyChangedThisFromItsPreviousValue  Whether apply
 *   changed it.
 * @property {number} applyChangedThisValueAtThisTimestampMS  When apply
 *   changed it; NEVER_CHANGED when it never did.
 * @property {string} oldValue  Its value before apply, as text.
 * @property {"string"|"integer"|"boolean"} oldValueDatatype  The old
 *   value's type.
 */

/**
 * @typedef {object} Meaning  One setting, as the dictionary has it.
 * @property {string} description  What the setting is.
 * @property {"string"|"integer"|"boolean"} oldValueDatatype  The type of
 *   its value.
 */

/**
 * @typedef {object} Observation  A setting as apply found and left it.
 * @property {string} key  The setting's name, with its target when it
 *   has one.
 * @property {string|number|boolean} oldValue  Its value before apply.
 * @property {string|number|boolean} newValue  Its value after.
 */

/** The time an entry gives for a setting apply never changed. */
export const NEVER_CHANGED = -1;

/**
 * Checks that an old value, as text, reads as its type.
 * @type {Map<string, (text: string) => boolean>}
 */
const READABLE = new Map([
  ["string", () => true],
  ["integer", (text) => /^-?\d+$/.test(text)],
  ["boolean", (text) => text === "true" || text === "false"],
]);

/**
 * Tells whether a value is an entry as this tool writes it.
 * @param {unknown} entry  The value.
 * @returns {boolean}
 */
function isEntry(entry) {
  const readable = READABLE.get(entry?.oldValueDatatype);
  const changed = entry?.applyChangedThisFromItsPreviousValue;
  const at = entry?.applyChangedThisValueAtThisTimestampMS;
  const timed = changed ? at >= 0 : at === NEVER_CHANGED;
  return (
    typeof entry?.description === "string" &&
    typeof changed === "boolean" &&
    Number.isInteger(at) &&
    timed &&
    typeof entry.oldValue === "string" &&
    readable !== undefined &&
    readable !== null &&
    readable(entry.oldValue)
  );
}

/**
 * Finds the shipped dictionary of the settings apply changes, among the
 * shipped defaults.
 * @param {string} [configDir]  The `app-config` folder; the feature's own
 *   unless a caller passes another.
 * @returns {string}
 */
export function applySettingsDictionaryPath(configDir) {
  const defaultsDir = shippedDefaultsDir(configDir);
  return path.join(defaultsDir, "apply-settings-dictionary.json");
}

/**
 * Reads the shipped dictionary of the settings apply changes. Its keys
 * that start with `_`, such as `_comment`, explain the file, and aren't
 * settings.
 * @param {string} [configDir]  The `app-config` folder; the feature's own
 *   unless a caller passes another.
 * @returns {Map<string, Meaning>} Each setting's meaning, by its name.
 * @throws {Error} When an entry lacks a description or a known type, so
 *   apply never records a setting it can't describe.
 */
export function loadApplySettingsDictionary(configDir) {
  const dictionaryPath = applySettingsDictionaryPath(configDir);
  const dictionary = readJson(dictionaryPath);
  const settings = Object.entries(dictionary ?? {}).filter(
    ([name]) => !name.startsWith("_"),
  );
  const broken = settings.filter(
    ([, meaning]) =>
      typeof meaning?.description !== "string" ||
      meaning.description === "" ||
      !READABLE.has(meaning.oldValueDatatype),
  );
  if (broken.length > 0) {
    const names = broken.map(([name]) => name).join(", ");
    throw new Error(
      `${dictionaryPath} gives ${names} no description or no known type.`,
    );
  }
  return new Map(settings);
}

/**
 * Reads apply's record.
 * @param {object} host  The host.
 * @param {string} recordPath  The record's file.
 * @returns {Map<string, Entry>|null} Each setting's entry, in the order
 *   apply recorded them; null when there is no record.
 * @throws {Error} When the file isn't a record this tool wrote, so
 *   undo-apply never acts on a damaged one.
 */
export function readRecord(host, recordPath) {
  if (!host.exists(recordPath)) {
    return null;
  }
  let parsed;
  try {
    const text = host.readText(recordPath);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${recordPath} isn't valid json.`, { cause: error });
  }
  const isObject =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const entries = isObject ? Object.entries(parsed) : [];
  if (!isObject || !entries.every(([, entry]) => isEntry(entry))) {
    throw new Error(`${recordPath} isn't a record this tool wrote.`);
  }
  return new Map(entries);
}

/**
 * Writes apply's record whole, making its folder when it's missing.
 * @param {object} host  The host.
 * @param {string} recordPath  The record's file.
 * @param {Map<string, Entry>} record  The record.
 */
export function writeRecord(host, recordPath, record) {
  host.makeUserDir(path.dirname(recordPath), 0o755);
  const text = JSON.stringify(Object.fromEntries(record), null, 2);
  host.writeUserFile(recordPath, `${text}\n`, 0o644);
}

/**
 * Splits a setting's key into its name and what it applies to.
 * @param {string} key  Such as `firewallRule:443/tcp`.
 * @returns {{name: string, target: string}} The target is empty for a
 *   setting there is only one of, such as `nginxServiceEnabled`.
 */
export function partsOf(key) {
  const colon = key.indexOf(":");
  return colon === -1
    ? { name: key, target: "" }
    : { name: key.slice(0, colon), target: key.slice(colon + 1) };
}

/**
 * Reads a setting's old value back, as its type.
 * @param {Entry} entry  The setting's entry.
 * @returns {string|number|boolean}
 */
export function oldValueOf(entry) {
  if (entry.oldValueDatatype === "boolean") {
    return entry.oldValue === "true";
  }
  if (entry.oldValueDatatype === "integer") {
    return Number.parseInt(entry.oldValue, 10);
  }
  return entry.oldValue;
}

/**
 * Tells whether apply changed a setting.
 * @param {Map<string, Entry>} record  apply's record.
 * @param {string} key  The setting.
 * @returns {boolean}
 */
export function changedByApply(record, key) {
  return record.get(key)?.applyChangedThisFromItsPreviousValue === true;
}

/**
 * Describes a thing apply made where there was none: a file, a folder, a
 * package, an account, a rule or a line.
 * @param {string} key  The setting.
 * @returns {Observation}
 */
export function made(key) {
  return { key, oldValue: false, newValue: true };
}

/**
 * Describes such a thing that apply found already there, and left.
 * @param {string} key  The setting.
 * @returns {Observation}
 */
export function found(key) {
  return { key, oldValue: true, newValue: true };
}

/**
 * Names a value's type, as the record writes it.
 * @param {unknown} value  The value.
 * @returns {string} `string`, `integer` or `boolean`; otherwise the
 *   value's own type, which no setting has.
 */
function datatypeOf(value) {
  return Number.isInteger(value) ? "integer" : typeof value;
}

/**
 * Makes the recorder that apply's stages call for each setting they
 * change, or find as they need it. It writes the record at once, unless
 * the record says so already: an entry that says apply changed the
 * setting stays as it is, and so does one that says apply found it so,
 * until apply changes it.
 * @param {object} host  The host.
 * @param {string} recordPath  The record's file.
 * @param {Map<string, Entry>} record  The record, changed in place.
 * @param {Map<string, Meaning>} dictionary  The settings apply changes.
 * @returns {(observation: Observation) => void}
 * @throws {Error} From the recorder, for a setting the dictionary lacks
 *   or an old value of another type, since the record would then hold
 *   something undo-apply can't read.
 */
export function recorder(host, recordPath, record, dictionary) {
  return ({ key, oldValue, newValue }) => {
    const { name } = partsOf(key);
    const meaning = dictionary.get(name);
    if (meaning === undefined || meaning === null) {
      throw new Error(`${name} isn't in apply's settings dictionary.`);
    }
    if (datatypeOf(oldValue) !== meaning.oldValueDatatype) {
      throw new Error(
        `${key}'s old value, ${String(oldValue)}, isn't a ` +
          `${meaning.oldValueDatatype}, as the dictionary says it is.`,
      );
    }
    const changed = oldValue !== newValue;
    const known = record.get(key);
    const kept =
      known !== undefined &&
      known !== null &&
      (known.applyChangedThisFromItsPreviousValue || !changed);
    if (kept) {
      return;
    }
    const now = host.now();
    // Moved to the end, so the record lists changes in the order made.
    record.delete(key);
    record.set(key, {
      description: meaning.description,
      applyChangedThisFromItsPreviousValue: changed,
      applyChangedThisValueAtThisTimestampMS: changed ? now : NEVER_CHANGED,
      oldValue: String(oldValue),
      oldValueDatatype: meaning.oldValueDatatype,
    });
    writeRecord(host, recordPath, record);
  };
}

/**
 * Lists the folders that writing into a folder would create, outermost
 * first, so the change that writes there can record them, and undo-apply
 * can remove them again.
 * @param {object} host  The host.
 * @param {string} folder  The folder written into.
 * @returns {string[]}
 */
export function foldersToMake(host, folder) {
  const missing = [];
  let current = folder;
  while (!host.exists(current) && current !== path.dirname(current)) {
    missing.unshift(current);
    current = path.dirname(current);
  }
  return missing;
}
