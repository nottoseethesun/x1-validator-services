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
import {
  defaultConfigDir,
  loadSettings,
  overrideFilePath,
} from "../../src/lib/settings.js";

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
 * Changes one shipped value to another the schema accepts. Each part of
 * a path gets `changed-` in front, so no folder of the changed path
 * exists on a stock system, and no shipped path or folder appears
 * inside a changed one. A number goes up by one.
 * @param {string} name  The setting.
 * @param {unknown} value  Its shipped value.
 * @returns {unknown} The changed value.
 * @throws {Error} For a kind of value this helper can't change yet, so a
 *   new kind of setting can't slip through untested.
 */
function changedValue(name, value) {
  if (typeof value === "string") {
    return value
      .split("/")
      .map((part) => (part === "" ? part : `changed-${part}`))
      .join("/");
  }
  if (typeof value === "number") {
    return value + 1;
  }
  throw new Error(`changedValue can't change ${name} yet; teach it how.`);
}

/**
 * Loads the shipped settings, and settings from a copy whose override
 * changes every one of them.
 * @returns {{shipped: object, changed: object}} The two sets of settings.
 */
export function shippedAndChangedSettings() {
  const shipped = loadSettings(copyShippedConfig().configDir);
  const override = Object.fromEntries(
    Object.entries(shipped).map(([name, value]) => [
      name,
      changedValue(name, value),
    ]),
  );
  const { configDir } = copyShippedConfig(JSON.stringify(override));
  return { shipped, changed: loadSettings(configDir) };
}
