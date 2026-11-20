/**
 * @file x1-validator-private-rpc/src/lib/settings.js
 * @description
 * Loads the tool's settings. The shipped defaults hold the one value of
 * each setting. The operator's override file holds only what they
 * change, and is merged over the defaults setting by setting. The
 * merged settings are checked against the shipped schema before any is
 * used: every problem is listed at once, each naming the setting, what
 * it must be and what it is, and the tool refuses to go on. An unknown
 * setting is refused too, since a misspelled one would otherwise be
 * ignored without a word. So is any other json file in the operator's
 * folder, such as a misnamed override, but not a hidden one, such as an
 * editor's lock file.
 *
 * A key that starts with `_` is a note, such as the warning beside a
 * setting in the shipped file, since json has no comments. The schema
 * allows it, and the settings leave it out.
 *
 * Settings are read when a command runs, never as a module loads, and
 * nothing keeps a copy of a default elsewhere.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { maskKeyLikeRuns } from "./api-key.js";

const SETTINGS_FILE = "private-rpc.json";
const SCHEMA_FILE = "private-rpc.schema.json";
const DEFAULTS_FOLDER = "app-defaults-for-user-configurable";
const OVERRIDES_FOLDER = "user-configurable";

/**
 * Finds the feature's `app-config` folder from this file's own location.
 * @returns {string} Its absolute path.
 */
export function defaultConfigDir() {
  return fileURLToPath(new URL("../../app-config/", import.meta.url));
}

/**
 * Finds the folder of the shipped defaults, which also holds the
 * dictionary of the settings apply changes.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a caller passes another.
 * @returns {string} Its path.
 */
export function shippedDefaultsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, DEFAULTS_FOLDER);
}

/**
 * Finds the operator's override file.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a caller passes another.
 * @returns {string} Its path.
 */
export function overrideFilePath(configDir = defaultConfigDir()) {
  return path.join(configDir, OVERRIDES_FOLDER, SETTINGS_FILE);
}

/**
 * Refuses a json file in the operator's folder that the tool doesn't
 * read. Settings saved under another name, such as `private_rpc.json`,
 * would otherwise leave the tool on its defaults without a word. Other
 * files pass, such as the folder's README, or `private-rpc.json.save`,
 * which nano leaves when its ssh session drops in the middle of an edit.
 * So does a file whose name starts with a dot, such as
 * `.#private-rpc.json`, the lock Emacs keeps while an edit is unsaved.
 * @param {string} overridePath  The operator's override file.
 * @throws {Error} Naming each such file, so no setting is ignored.
 */
function refuseUnreadFiles(overridePath) {
  const folder = path.dirname(overridePath);
  if (!fs.existsSync(folder)) {
    return;
  }
  const unread = fs
    .readdirSync(folder)
    .filter(
      (name) =>
        name !== SETTINGS_FILE &&
        name.endsWith(".json") &&
        !name.startsWith("."),
    );
  if (unread.length > 0) {
    throw new Error(
      `${folder} holds ${unread.join(", ")}, which the tool doesn't read. ` +
        `It reads your settings from ${SETTINGS_FILE} alone, so move any ` +
        "settings in the other file(s) into it, then remove the other " +
        "file(s).",
    );
  }
}

/**
 * Reads a json file, saying which file is broken when it doesn't parse.
 * @param {string} filePath  The file.
 * @returns {unknown} Its content.
 * @throws {Error} When the file isn't valid json, naming the file, since
 *   json's own message doesn't.
 */
export function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} isn't valid json: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Reads the shipped schema, which holds every setting's rules, such as
 * the form a hostname must have.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a caller passes another.
 * @returns {object} The schema.
 */
export function readSchema(configDir = defaultConfigDir()) {
  return readJson(path.join(shippedDefaultsDir(configDir), SCHEMA_FILE));
}

/**
 * Tells whether a value has the form the schema asks of one setting, so
 * a value typed in follows the same rule as the setting.
 * @param {string} name  The setting.
 * @param {string} value  The value.
 * @param {string} configDir  The `app-config` folder.
 * @returns {boolean}
 */
function fitsSetting(name, value, configDir) {
  const ajv = new Ajv2020({ strict: true });
  const schema = readSchema(configDir);
  const rule = new Map(Object.entries(schema.properties)).get(name);
  return ajv.validate(rule, value);
}

/**
 * Tells whether a hostname has the form the schema asks of the
 * `hostname` setting, so a hostname typed in follows the same rule.
 * @param {string} hostname  The hostname.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a caller passes another.
 * @returns {boolean}
 */
export function isHostname(hostname, configDir = defaultConfigDir()) {
  return fitsSetting("hostname", hostname, configDir);
}

/**
 * Tells whether an email address has the form the schema asks of the
 * `acmeEmail` setting, so an api key's email follows the same rule.
 * @param {string} email  The address.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a caller passes another.
 * @returns {boolean}
 */
export function isEmail(email, configDir = defaultConfigDir()) {
  return fitsSetting("acmeEmail", email, configDir);
}

/**
 * Describes one schema problem in the operator's words. A problem with a
 * setting also gives the schema's description of it, which says what
 * the setting must be, since Ajv's own words may only quote a pattern.
 * The setting's value is quoted with `<key>` in place of anything that
 * looks like a key, since a keyed url pasted into a setting would
 * otherwise reach the cron job's log of ensure every minute.
 * @param {object} error  One of Ajv's errors.
 * @param {object} settings  The merged settings.
 * @param {string} overridePath  The operator's override file.
 * @param {Map<string, string>} descriptions  Each setting's description
 *   in the schema.
 * @returns {string}
 */
function describeProblem(error, settings, overridePath, descriptions) {
  if (error.keyword === "additionalProperties") {
    const name = error.params.additionalProperty;
    return (
      `"${name}" isn't a setting this tool reads. Remove it from ` +
      `${overridePath}.`
    );
  }
  const name = error.instancePath.slice(1);
  if (name === "") {
    return `The settings: ${error.message}. Check ${overridePath}.`;
  }
  const value = new Map(Object.entries(settings)).get(name) ?? null;
  const shown = maskKeyLikeRuns(JSON.stringify(value));
  return [
    `${name}: ${error.message} (it is ${shown}).`,
    descriptions.get(name) ?? "",
    `Change it in ${overridePath}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * Checks settings against the schema.
 * @param {object} schema  The schema.
 * @param {object} settings  The merged settings.
 * @param {string} overridePath  The operator's override file, for the
 *   messages.
 * @returns {string[]} One message per problem, or none when they pass.
 */
export function settingsProblems(schema, settings, overridePath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (validate(settings)) {
    return [];
  }
  // A path's or a url's form is in the definition its $ref names.
  const definitions = new Map(Object.entries(schema.$defs ?? {}));
  const descriptions = new Map(
    Object.entries(schema.properties).map(([name, rule]) => {
      const shared =
        typeof rule.$ref === "string"
          ? definitions.get(rule.$ref.split("/").at(-1))
          : undefined;
      const parts = [rule.description, shared?.description].filter(
        (text) => typeof text === "string" && text !== "",
      );
      return [name, parts.join(" ")];
    }),
  );
  return validate.errors.map((error) =>
    describeProblem(error, settings, overridePath, descriptions),
  );
}

/**
 * Loads, merges and checks the settings.
 * @param {string} [configDir]  The `app-config` folder, the feature's own
 *   unless a test passes another.
 * @returns {object} The settings, each key holding its value.
 * @throws {Error} Listing every problem, when a file is broken, a json
 *   file the tool doesn't read sits beside the override, or a setting is
 *   wrong or unknown, so no command runs on settings the operator didn't
 *   mean.
 */
export function loadSettings(configDir = defaultConfigDir()) {
  const defaultsDir = shippedDefaultsDir(configDir);
  const schema = readSchema(configDir);
  const defaults = readJson(path.join(defaultsDir, SETTINGS_FILE));
  const overridePath = overrideFilePath(configDir);
  refuseUnreadFiles(overridePath);
  const overrides = fs.existsSync(overridePath) ? readJson(overridePath) : {};
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    throw new Error(`${overridePath} must hold one json object.`);
  }
  const merged = { ...defaults, ...overrides };
  const problems = settingsProblems(schema, merged, overridePath);
  if (problems.length > 0) {
    throw new Error(
      `The settings have ${problems.length} problem(s):\n` +
        problems.map((problem) => `  ${problem}`).join("\n"),
    );
  }
  return Object.fromEntries(
    Object.entries(merged).filter(
      ([name]) => name !== "$schema" && !name.startsWith("_"),
    ),
  );
}
