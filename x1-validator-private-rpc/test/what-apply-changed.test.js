/**
 * @file x1-validator-private-rpc/test/what-apply-changed.test.js
 * @description
 * Tests apply's record of what it changed, and the shipped dictionary of
 * the settings apply changes:
 *
 * - on a fresh validator, apply records every setting in the dictionary
 *   as changed
 * - an entry copies the dictionary's description and type, and holds the
 *   old value as text, and the time apply changed the setting, or -1
 *   when it never did
 * - an entry that says apply changed a setting is never written over
 * - one that says apply found it so is replaced, at the end, once apply
 *   changes it
 * - the record refuses a setting the dictionary lacks, an old value of
 *   another type, and a damaged file
 * - the dictionary refuses an entry it can't describe
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTestTempFolder } from "../../scripts/_test-temp-folders.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import {
  applySettingsDictionaryPath,
  changedByApply,
  found,
  loadApplySettingsDictionary,
  made,
  NEVER_CHANGED,
  oldValueOf,
  partsOf,
  readRecord,
  recorder,
} from "../src/cli/what-apply-changed.js";
import { appliedValidator } from "./helpers/applied-validator.js";
import { createFakeHost } from "./helpers/fake-host.js";

/**
 * Makes an empty record, and the recorder apply would use.
 * @returns {{host: object, record: Map<string, object>, write: Function,
 *   recordPath: string, dictionary: Map<string, object>}}
 */
function emptyRecord() {
  const host = createFakeHost({ respond: () => undefined });
  const recordPath = featurePaths().whatApplyChangedPath;
  const dictionary = loadApplySettingsDictionary();
  const record = new Map();
  const write = recorder(host, recordPath, record, dictionary);
  return { host, record, write, recordPath, dictionary };
}

/**
 * Counts the times the record was written.
 * @param {object} host  The fake host.
 * @param {string} recordPath  The record's file.
 * @returns {number}
 */
function writes(host, recordPath) {
  return host.calls.filter(
    (call) => call.kind === "writeUserFile" && call.path === recordPath,
  ).length;
}

test("on a fresh validator, apply records every setting in its dictionary as changed, in the dictionary's words", async () => {
  const { host } = await appliedValidator(
    {},
    { savePassword: true, acmeStaging: true },
  );
  const dictionary = loadApplySettingsDictionary();
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const names = new Set([...record.keys()].map((key) => partsOf(key).name));
  assert.deepEqual([...names].sort(), [...dictionary.keys()].sort());
  for (const [key, entry] of record) {
    const meaning = dictionary.get(partsOf(key).name);
    assert.deepEqual(
      [
        entry.description,
        entry.oldValueDatatype,
        entry.applyChangedThisFromItsPreviousValue,
        entry.oldValue,
      ],
      [meaning.description, meaning.oldValueDatatype, true, "false"],
      key,
    );
  }
});

test("an entry copies the dictionary's words, and holds the old value as text and the time", async () => {
  const { host, write, recordPath, dictionary } = emptyRecord();
  assert.equal(readRecord(host, recordPath), null);
  await host.sleep(1234);
  write(made("firewallRule:443/tcp"));
  const written = JSON.parse(host.files.get(recordPath));
  assert.deepEqual(written, {
    "firewallRule:443/tcp": {
      description: dictionary.get("firewallRule").description,
      applyChangedThisFromItsPreviousValue: true,
      applyChangedThisValueAtThisTimestampMS: 1234,
      oldValue: "false",
      oldValueDatatype: "boolean",
    },
  });
  const read = readRecord(host, recordPath);
  assert.equal(changedByApply(read, "firewallRule:443/tcp"), true);
  assert.equal(oldValueOf(read.get("firewallRule:443/tcp")), false);
});

test("a change is never written over, and a found setting turns changed, at the end, once apply changes it", async () => {
  const { host, record, write, recordPath } = emptyRecord();
  write(made("firewallRule:443/tcp"));
  await host.sleep(1000);
  write(found("firewallRule:443/tcp"));
  assert.equal(writes(host, recordPath), 1);
  assert.equal(
    record.get("firewallRule:443/tcp").applyChangedThisValueAtThisTimestampMS,
    0,
  );
  const vaultKey = "vault:/home/validator/vault.json";
  write(found(vaultKey));
  write(found(vaultKey));
  assert.equal(writes(host, recordPath), 2);
  const foundVault = record.get(vaultKey);
  assert.deepEqual(
    [
      foundVault.applyChangedThisFromItsPreviousValue,
      foundVault.applyChangedThisValueAtThisTimestampMS,
      foundVault.oldValue,
    ],
    [false, NEVER_CHANGED, "true"],
  );
  write(made("gitHook:/x1console/.git/hooks/post-merge"));
  write(made(vaultKey));
  assert.deepEqual(
    [...record.keys()],
    [
      "firewallRule:443/tcp",
      "gitHook:/x1console/.git/hooks/post-merge",
      vaultKey,
    ],
  );
  const vault = record.get(vaultKey);
  assert.deepEqual(
    [
      vault.applyChangedThisFromItsPreviousValue,
      vault.applyChangedThisValueAtThisTimestampMS,
      vault.oldValue,
    ],
    [true, 1000, "false"],
  );
});

test("refuses a setting the dictionary lacks, and an old value of another type", () => {
  const { write } = emptyRecord();
  assert.throws(() => write(made("someoneElsesSetting:/a")), {
    message: "someoneElsesSetting isn't in apply's settings dictionary.",
  });
  assert.throws(
    () => write({ key: "nginxServiceMasked", oldValue: "no", newValue: "yes" }),
    {
      message:
        "nginxServiceMasked's old value, no, isn't a boolean, as the dictionary says it is.",
    },
  );
});

test("refuses a damaged record", () => {
  const { host, recordPath } = emptyRecord();
  host.files.set(recordPath, "{ damaged");
  assert.throws(() => readRecord(host, recordPath), {
    message: /isn't valid json/,
  });
  const entry = {
    description: "A setting.",
    applyChangedThisFromItsPreviousValue: true,
    applyChangedThisValueAtThisTimestampMS: 5,
    oldValue: "false",
    oldValueDatatype: "boolean",
  };
  const unchanged = {
    ...entry,
    applyChangedThisFromItsPreviousValue: false,
    applyChangedThisValueAtThisTimestampMS: NEVER_CHANGED,
  };
  for (const damaged of [
    [entry],
    { a: { ...entry, oldValue: "maybe" } },
    { a: { ...entry, oldValueDatatype: "date" } },
    { a: { ...entry, applyChangedThisValueAtThisTimestampMS: 1.5 } },
    { a: { ...entry, applyChangedThisValueAtThisTimestampMS: undefined } },
    { a: { ...entry, applyChangedThisValueAtThisTimestampMS: NEVER_CHANGED } },
    { a: { ...unchanged, applyChangedThisValueAtThisTimestampMS: 5 } },
    { a: { ...entry, description: null } },
  ]) {
    host.files.set(recordPath, JSON.stringify(damaged));
    assert.throws(() => readRecord(host, recordPath), {
      message: `${recordPath} isn't a record this tool wrote.`,
    });
  }
  host.files.set(
    recordPath,
    JSON.stringify({
      a: { ...entry, oldValue: "-7", oldValueDatatype: "integer" },
      b: unchanged,
    }),
  );
  const read = readRecord(host, recordPath);
  assert.equal(oldValueOf(read.get("a")), -7);
  assert.equal(changedByApply(read, "b"), false);
});

test("a key splits into the setting's name and its target, which may hold a colon", () => {
  assert.deepEqual(partsOf("cronLine:* * * * * a:b"), {
    name: "cronLine",
    target: "* * * * * a:b",
  });
  assert.deepEqual(partsOf("nginxServiceEnabled"), {
    name: "nginxServiceEnabled",
    target: "",
  });
  assert.equal(
    oldValueOf({ oldValue: "kept as text", oldValueDatatype: "string" }),
    "kept as text",
  );
});

test("the dictionary refuses an entry with no description or no known type", () => {
  const configDir = makeTestTempFolder("dictionary");
  const file = applySettingsDictionaryPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dictionary = {
    _comment: "Explains the file; not a setting.",
    good: { description: "A setting.", oldValueDatatype: "boolean" },
    untyped: { description: "No type.", oldValueDatatype: "date" },
    silent: { description: "", oldValueDatatype: "string" },
  };
  fs.writeFileSync(file, JSON.stringify(dictionary));
  assert.throws(() => loadApplySettingsDictionary(configDir), {
    message: `${file} gives untyped, silent no description or no known type.`,
  });
  delete dictionary.untyped;
  delete dictionary.silent;
  fs.writeFileSync(file, JSON.stringify(dictionary));
  assert.deepEqual(
    [...loadApplySettingsDictionary(configDir).keys()],
    ["good"],
  );
});
