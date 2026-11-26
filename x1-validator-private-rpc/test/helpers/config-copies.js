/**
 * @file x1-validator-private-rpc/test/helpers/config-copies.js
 * @description
 * Temporary copies of the feature's `app-config` folder, so no test reads
 * the operator's own settings: a copy holds the shipped files, and an
 * override only when a test writes one. One kind of copy changes every
 * setting from its shipped value, so a test can tell a configured value
 * from a default the code might use instead. The changed values are
 * worked out from the shipped ones, so no test keeps a copy of a default.
 */

import fs from "node:fs";
import path from "node:path";
import { makeTestTempFolder } from "../../../scripts/_test-temp-folders.js";
import { listFilesUnder } from "../../../scripts/_tools.js";
import { homePath } from "../../src/cli/feature-paths.js";
import {
  defaultConfigDir,
  loadSettings,
  overrideFilePath,
  readSchema,
} from "../../src/lib/settings.js";

/** The schema's types for a path, in the home folder or the system's. */
const PATH_TYPES = ["#/$defs/homePath", "#/$defs/systemPath"];

/**
 * Copies the shipped `app-config` folder, leaving out every file in the
 * operator's own folder, and writes an override when given one.
 * @param {string} [overrideText]  The override file's text.
 * @returns {{configDir: string, overridePath: string}}
 */
export function copyShippedConfig(overrideText) {
  const configDir = makeTestTempFolder("settings");
  const operatorFolder = path.dirname(overrideFilePath());
  for (const file of listFilesUnder(defaultConfigDir(), ".")) {
    const source = path.join(defaultConfigDir(), file);
    if (path.dirname(source) !== operatorFolder) {
      const target = path.join(configDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  const overridePath = overrideFilePath(configDir);
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  if (overrideText !== undefined) {
    fs.writeFileSync(overridePath, overrideText);
  }
  return { configDir, overridePath };
}

/**
 * Loads the shipped settings, from a copy with no override.
 * @returns {object}
 */
export function shippedSettings() {
  const { configDir } = copyShippedConfig();
  return loadSettings(configDir);
}

/**
 * Changes one shipped value to another the schema accepts. Each part of
 * a path, a file name or a url gets `changed-` in front, so no folder of
 * a changed path exists on a stock system, and no shipped path or folder
 * appears inside a changed one. A url's scheme and a home folder's `~`
 * stay. A number goes up by one, or down by one when it's shipped at the
 * schema's maximum. A number whose rule lists the values it may take,
 * such as apiKeyCountCheckHours, takes the next value in the list, or
 * the one before when it's shipped at the list's end.
 * @param {string} name  The setting.
 * @param {unknown} value  Its shipped value.
 * @param {{maximum?: number, enum?: number[]}} rule  The setting's rule
 *   in the schema.
 * @returns {unknown} The changed value.
 * @throws {Error} For a kind of value this helper can't change yet, so a
 *   new kind of setting can't slip through untested.
 */
function changedValue(name, value, rule) {
  if (typeof value === "string") {
    const keep = (part) => part === "" || part === "~" || part.endsWith(":");
    return value
      .split("/")
      .map((part) => (keep(part) ? part : `changed-${part}`))
      .join("/");
  }
  if (typeof value === "number" && Array.isArray(rule.enum)) {
    const at = rule.enum.indexOf(value);
    return rule.enum.at(at === rule.enum.length - 1 ? at - 1 : at + 1);
  }
  if (typeof value === "number") {
    return value === rule.maximum ? value - 1 : value + 1;
  }
  throw new Error(`changedValue can't change ${name} yet. Teach it how.`);
}

/**
 * Loads the shipped settings, and settings from a copy whose override
 * changes every one of them.
 * @returns {{shipped: object, changed: object}} The two sets of settings.
 */
export function shippedAndChangedSettings() {
  const shipped = shippedSettings();
  const schema = readSchema();
  const rules = new Map(Object.entries(schema.properties));
  const override = Object.fromEntries(
    Object.entries(shipped).map(([name, value]) => [
      name,
      changedValue(name, value, rules.get(name)),
    ]),
  );
  const { configDir } = copyShippedConfig(JSON.stringify(override));
  return { shipped, changed: loadSettings(configDir) };
}

/**
 * Names the path settings, as the schema types them: apply makes its
 * files there, and undo-apply removes them.
 * @returns {string[]}
 */
function pathSettings() {
  const schema = readSchema();
  const rules = Object.entries(schema.properties);
  return rules
    .filter(([, rule]) => PATH_TYPES.includes(rule.$ref))
    .map(([name]) => name);
}

/**
 * Finds the path settings a command got wrong, from the fake host's
 * record of its calls and the texts of the files it wrote: each one
 * whose shipped path it used, in a call or inside a file, and each one
 * whose changed path no call used.
 * @param {object[]} calls  The fake host's calls during the command.
 * @param {object} shipped  The shipped settings.
 * @param {object} changed  The settings with every value changed.
 * @param {string} homeDir  The home folder that `~` stands for.
 * @param {string[]} [texts]  The texts of the files the command wrote,
 *   such as nginx's configuration, which names paths that settings give.
 * @returns {{shippedUsed: string[], changedUnused: string[]}} The
 *   settings' names.
 */
export function wrongPaths(calls, shipped, changed, homeDir, texts = []) {
  const touched = calls
    .map((call) => call.path ?? [call.command, ...call.args].join(" "))
    .join("\n");
  const searched = [touched, ...texts].join("\n");
  const used = (text, settings, name) =>
    text.includes(homePath(settings[name], homeDir));
  const names = pathSettings();
  return {
    shippedUsed: names.filter((name) => used(searched, shipped, name)),
    changedUnused: names.filter((name) => !used(touched, changed, name)),
  };
}
