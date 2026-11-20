/**
 * @file x1-validator-private-rpc/test/settings.test.js
 * @description
 * Tests how the settings load: the operator's override merged over the
 * shipped defaults setting by setting, without the shipped file's notes,
 * and every problem refused at once, each named with what to change.
 * Each test works in a temporary copy of the shipped folder, so no test
 * reads or writes the operator's own settings, and takes the shipped
 * values from the copy rather than keeping its own.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeApiKey } from "../src/lib/api-key.js";
import { loadSettings, readSchema } from "../src/lib/settings.js";
import { copyShippedConfig } from "./helpers/config-copies.js";

/**
 * Loads the shipped settings alone.
 * @returns {object}
 */
function shippedSettings() {
  return loadSettings(copyShippedConfig().configDir);
}

test("without an override, the shipped file's values load, without $schema or its notes", () => {
  const { configDir } = copyShippedConfig();
  const shippedFile = path.join(
    configDir,
    "app-defaults-for-user-configurable",
    "private-rpc.json",
  );
  const { $schema, ...values } = JSON.parse(
    fs.readFileSync(shippedFile, "utf8"),
  );
  assert.equal(typeof $schema, "string");
  const notes = Object.keys(values).filter((name) => name.startsWith("_"));
  assert.notEqual(notes.length, 0);
  assert.deepEqual(
    loadSettings(configDir),
    Object.fromEntries(
      Object.entries(values).filter(([name]) => !notes.includes(name)),
    ),
  );
});

test("an override changes only the settings it names", () => {
  const shipped = shippedSettings();
  const timeout = shipped.requestTimeoutSeconds + 1;
  const settings = loadSettings(
    copyShippedConfig(JSON.stringify({ requestTimeoutSeconds: timeout }))
      .configDir,
  );
  assert.deepEqual(settings, { ...shipped, requestTimeoutSeconds: timeout });
});

test("an unknown setting is refused, saying where to remove it", () => {
  const { configDir, overridePath } = copyShippedConfig(
    '{"requestTimeout": 30}',
  );
  assert.throws(() => loadSettings(configDir), {
    message: new RegExp(
      `"requestTimeout" isn't a setting this tool reads. Remove it from ` +
        `${overridePath}.`,
    ),
  });
});

test("a value out of range is refused with its rule and its value", () => {
  const { configDir } = copyShippedConfig('{"requestTimeoutSeconds": 1000000}');
  assert.throws(() => loadSettings(configDir), {
    message: /requestTimeoutSeconds: must be <= \d+ \(it is 1000000\)/,
  });
});

test("a value in the wrong form is refused with what the setting must be, from the schema", () => {
  const url = "https://x1-rpc.example.com";
  const { configDir } = copyShippedConfig(JSON.stringify({ hostname: url }));
  const { description } = readSchema(configDir).properties.hostname;
  assert.throws(
    () => loadSettings(configDir),
    (error) => error.message.includes(`(it is "${url}"). ${description}`),
  );
});

test("a path in the wrong form is refused with the form its shared definition gives", () => {
  const override = JSON.stringify({ hashedApiKeysPath: "$HOME/keys.json" });
  const { configDir } = copyShippedConfig(override);
  const schema = readSchema(configDir);
  const ref = schema.properties.hashedApiKeysPath.$ref.split("/").at(-1);
  const form = new Map(Object.entries(schema.$defs)).get(ref).description;
  assert.throws(
    () => loadSettings(configDir),
    (error) => error.message.includes(form),
  );
});

test("a refused value shows <key> in place of a key pasted into it", () => {
  const key = makeApiKey();
  const url = `https://x1-rpc.example.com/${key}`;
  const { configDir } = copyShippedConfig(JSON.stringify({ hostname: url }));
  assert.throws(
    () => loadSettings(configDir),
    (error) =>
      !error.message.includes(key) &&
      error.message.includes('(it is "https://x1-rpc.example.com/<key>")'),
  );
});

test("every problem is listed at once", () => {
  const { configDir } = copyShippedConfig(
    '{"requestTimeoutSeconds": 0, "hashedApiKeysMapPath": "relative/path"}',
  );
  assert.throws(() => loadSettings(configDir), {
    message:
      /2 problem\(s\)[\s\S]*hashedApiKeysMapPath[\s\S]*requestTimeoutSeconds/,
  });
});

test("an override that isn't valid json is refused, naming the file", () => {
  const { configDir, overridePath } = copyShippedConfig("{ not json");
  assert.throws(() => loadSettings(configDir), {
    message: new RegExp(`${overridePath} isn't valid json`),
  });
});

test("an override that isn't one object is refused", () => {
  const { configDir } = copyShippedConfig("[1, 2]");
  assert.throws(() => loadSettings(configDir), {
    message: /must hold one json object/,
  });
});

test("a settings file under another name is refused, naming it", () => {
  const { configDir, overridePath } = copyShippedConfig();
  const folder = path.dirname(overridePath);
  fs.writeFileSync(path.join(folder, "private_rpc.json"), "{}");
  assert.throws(() => loadSettings(configDir), {
    message: new RegExp(
      `${folder} holds private_rpc\\.json, which the tool doesn't read\\. ` +
        `It reads your settings from ${path.basename(overridePath)} alone`,
    ),
  });
});

test("files that aren't json, and hidden ones, such as the README or an editor's, may sit beside the override", () => {
  const { configDir, overridePath } = copyShippedConfig("{}");
  const folder = path.dirname(overridePath);
  const name = path.basename(overridePath);
  fs.writeFileSync(path.join(folder, "README.md"), "# Your Settings\n");
  // nano's leftover from a dropped ssh session, and vim's swap file.
  fs.writeFileSync(path.join(folder, `${name}.save`), "{");
  fs.writeFileSync(path.join(folder, `.${name}.swp`), "");
  // Emacs's lock while an edit is unsaved: a link to nothing, named .json.
  fs.symlinkSync(
    "validator@x1.4242:1700000000",
    path.join(folder, `.#${name}`),
  );
  assert.deepEqual(loadSettings(configDir), shippedSettings());
});
