/**
 * @file x1-validator-private-rpc/test/settings.test.js
 * @description
 * Tests how the settings load: the operator's override merged over the
 * shipped defaults setting by setting, and every problem refused at
 * once, each named with what to change. Each test works in a temporary
 * copy of the shipped folder, so no test reads or writes the operator's
 * own settings.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTestTempFolder } from "../../scripts/_test-temp-folders.js";
import { defaultConfigDir, loadSettings } from "../src/lib/settings.js";

const DEFAULTS = "app-defaults-for-user-configurable";

/**
 * Copies the shipped settings into a temporary folder, with an override
 * file holding the given text, if any.
 * @param {string} [overrideText]  The override file's text.
 * @returns {{configDir: string, overridePath: string}}
 */
function configWith(overrideText) {
  const configDir = makeTestTempFolder("settings");
  fs.mkdirSync(path.join(configDir, DEFAULTS));
  fs.mkdirSync(path.join(configDir, "user-configurable"));
  for (const name of ["private-rpc.json", "private-rpc.schema.json"]) {
    fs.copyFileSync(
      path.join(defaultConfigDir(), DEFAULTS, name),
      path.join(configDir, DEFAULTS, name),
    );
  }
  const overridePath = path.join(
    configDir,
    "user-configurable",
    "private-rpc.json",
  );
  if (overrideText !== undefined) {
    fs.writeFileSync(overridePath, overrideText);
  }
  return { configDir, overridePath };
}

test("without an override, the shipped values load, without $schema", () => {
  const settings = loadSettings(configWith().configDir);
  assert.equal(settings.requestTimeoutSeconds, 10);
  assert.equal(Object.hasOwn(settings, "$schema"), false);
});

test("an override changes only the settings it names", () => {
  const settings = loadSettings(
    configWith('{"requestTimeoutSeconds": 30}').configDir,
  );
  assert.equal(settings.requestTimeoutSeconds, 30);
  assert.equal(
    settings.keyHandOffPath,
    "/run/x1-validator-private-rpc/api-key",
  );
});

test("an unknown setting is refused, saying where to remove it", () => {
  const { configDir, overridePath } = configWith('{"requestTimeout": 30}');
  assert.throws(() => loadSettings(configDir), {
    message: new RegExp(
      `"requestTimeout" isn't a setting this tool reads. Remove it from ` +
        `${overridePath}.`,
    ),
  });
});

test("a value out of range is refused with its rule and its value", () => {
  const { configDir } = configWith('{"requestTimeoutSeconds": 500}');
  assert.throws(() => loadSettings(configDir), {
    message: /requestTimeoutSeconds: must be <= 120 \(it is 500\)/,
  });
});

test("every problem is listed at once", () => {
  const { configDir } = configWith(
    '{"requestTimeoutSeconds": 0, "keyHandOffPath": "relative/path"}',
  );
  assert.throws(() => loadSettings(configDir), {
    message: /2 problem\(s\)[\s\S]*keyHandOffPath[\s\S]*requestTimeoutSeconds/,
  });
});

test("an override that isn't valid json is refused, naming the file", () => {
  const { configDir, overridePath } = configWith("{ not json");
  assert.throws(() => loadSettings(configDir), {
    message: new RegExp(`${overridePath} isn't valid json`),
  });
});

test("an override that isn't one object is refused", () => {
  const { configDir } = configWith("[1, 2]");
  assert.throws(() => loadSettings(configDir), {
    message: /must hold one json object/,
  });
});
