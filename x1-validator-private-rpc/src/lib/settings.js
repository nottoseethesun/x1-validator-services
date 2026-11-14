/**
 * @file x1-validator-private-rpc/src/lib/settings.js
 * @description
 * Loads the tool's settings. The shipped defaults hold the one value of
 * each setting; the operator's override file holds only what they
 * change, and is merged over the defaults setting by setting. The
 * merged settings are checked against the shipped schema before any is
 * used: every problem is listed at once, each naming the setting, what
 * it must be and what it is, and the tool refuses to go on. An unknown
 * setting is refused too, since a misspelled one would otherwise be
 * ignored without a word. So is any file in the operator's folder other
 * than the override file and its README, such as a misnamed override.
 *
 * Settings are read when a command runs, never as a module loads, and
 * nothing keeps a copy of a default elsewhere.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const SETTINGS_FILE = "private-rpc.json";
const SCHEMA_FILE = "private-rpc.schema.json";
const DEFAULTS_FOLDER = "app-defaults-for-user-configurable";
const OVERRIDES_FOLDER = "user-configurable";

/** The file that explains the operator's folder, which the tool ships. */
const OVERRIDES_README = "README.md";

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
 * @param {string} [configDir]  The `app-config` folder; the feature's own
 *   unless a caller passes another.
 * @returns {string} Its path.
 */
export function shippedDefaultsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, DEFAULTS_FOLDER);
}

/**
 * Finds the operator's override file.
 * @param {string} [configDir]  The `app-config` folder; the feature's own
 *   unless a caller passes another.
 * @returns {string} Its path.
 */
export function overrideFilePath(configDir = defaultConfigDir()) {
  return path.join(configDir, OVERRIDES_FOLDER, SETTINGS_FILE);
}

/**
 * Refuses a file in the operator's folder that the tool doesn't read.
 * Settings saved under another name, such as `private_rpc.json`, would
 * otherwise leave the tool on its defaults without a word.
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
    .filter((name) => name !== SETTINGS_FILE && name !== OVERRIDES_README);
  if (unread.length > 0) {
    throw new Error(
      `${folder} holds ${unread.join(", ")}, which the tool doesn't read. ` +
        `It reads your settings from ${SETTINGS_FILE} alone, so move them ` +
        "there and remove the other file(s).",
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
 * Describes one schema problem in the operator's words.
 * @param {object} error  One of Ajv's errors.
 * @param {object} settings  The merged settings.
 * @param {string} overridePath  The operator's override file.
 * @returns {string}
 */
function describeProblem(error, settings, overridePath) {
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
  return (
    `${name}: ${error.message} (it is ${JSON.stringify(value)}). ` +
    `Change it in ${overridePath}.`
  );
}

/**
 * Checks settings against the schema.
 * @param {object} schema  The schema.
 * @param {object} settings  The merged settings.
 * @param {string} overridePath  The operator's override file, for the
 *   messages.
 * @returns {string[]} One message per problem; none when they pass.
 */
export function settingsProblems(schema, settings, overridePath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (validate(settings)) {
    return [];
  }
  return validate.errors.map((error) =>
    describeProblem(error, settings, overridePath),
  );
}

/**
 * Loads, merges and checks the settings.
 * @param {string} [configDir]  The `app-config` folder; the feature's own
 *   unless a test passes another.
 * @returns {object} The settings, each key holding its value.
 * @throws {Error} Listing every problem, when a file is broken, a file
 *   the tool doesn't read sits beside the override, or a setting is
 *   wrong or unknown, so no command runs on settings the operator didn't
 *   mean.
 */
export function loadSettings(configDir = defaultConfigDir()) {
  const defaultsDir = shippedDefaultsDir(configDir);
  const schema = readJson(path.join(defaultsDir, SCHEMA_FILE));
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
    Object.entries(merged).filter(([name]) => name !== "$schema"),
  );
}
