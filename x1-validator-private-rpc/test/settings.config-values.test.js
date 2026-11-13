/**
 * @file x1-validator-private-rpc/test/settings.config-values.test.js
 * @description
 * Tests the shipped settings, before any other test runs: every shipped
 * value passes its schema, every setting has a type or range rule, and
 * the shipped file holds exactly the settings the schema requires. A
 * wrong shipped value would break whatever reads it; run first, these
 * tests name the cause.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { defaultConfigDir, settingsProblems } from "../src/lib/settings.js";

/**
 * Reads a shipped json file.
 * @param {string} name  The file's name.
 * @returns {object}
 */
function shipped(name) {
  const filePath = path.join(
    defaultConfigDir(),
    "app-defaults-for-user-configurable",
    name,
  );
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("the shipped defaults pass their schema", () => {
  assert.deepEqual(
    settingsProblems(
      shipped("private-rpc.schema.json"),
      shipped("private-rpc.json"),
      "(shipped)",
    ),
    [],
  );
});

test("every setting the schema accepts has a type or range rule", () => {
  const schema = shipped("private-rpc.schema.json");
  for (const [name, rule] of Object.entries(schema.properties)) {
    assert.ok(
      rule.type !== undefined || rule.$ref !== undefined,
      `${name} has no type`,
    );
  }
});

test("the shipped file holds exactly the settings the schema requires", () => {
  const schema = shipped("private-rpc.schema.json");
  const names = Object.keys(shipped("private-rpc.json")).filter(
    (name) => name !== "$schema",
  );
  assert.deepEqual(names.sort(), [...schema.required].sort());
});
