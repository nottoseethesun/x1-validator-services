/**
 * @file test/project-files.test.js
 * @description
 * Tests how the gate finds its files in the project: test files, entry
 * points, modules and installed files, read from the project's own tree,
 * which the tests only read. It also tests the walk from the entry
 * points that finds modules only tests load.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  entryPointFiles,
  installedFiles,
  moduleFiles,
} from "../scripts/_project-files.js";
import {
  listFeatureTestFiles,
  listTestFiles,
  splitConfigValueTests,
} from "../scripts/_test-files.js";
import { listFilesUnder, projectRoot } from "../scripts/_tools.js";
import { findUnusedSrcModules } from "../scripts/_unused-src-modules.js";

const FEATURE = "x1-validator-private-rpc";

test("finds the tests of the tooling and of each feature, sorted", () => {
  const files = listTestFiles(projectRoot());
  assert.ok(files.includes("test/project-files.test.js"));
  assert.ok(files.includes(`${FEATURE}/test/cli.test.js`));
  assert.deepEqual(files, [...files].sort());
});

test("finds the features' tests alone, leaving out the tooling's", () => {
  const files = listFeatureTestFiles(projectRoot());
  assert.ok(files.includes(`${FEATURE}/test/cli.test.js`));
  assert.ok(files.every((file) => !file.startsWith("test/")));
});

test("puts the shipped-settings tests in a group of their own", () => {
  assert.deepEqual(
    splitConfigValueTests([
      "a/test/settings.config-values.test.js",
      "a/test/cli.test.js",
    ]),
    {
      configValues: ["a/test/settings.config-values.test.js"],
      others: ["a/test/cli.test.js"],
    },
  );
});

test("finds no files in a folder that doesn't exist", () => {
  assert.deepEqual(listFilesUnder(projectRoot(), "no-such-folder"), []);
});

test("takes src/*.js and each util tool's index.js as entry points", () => {
  const entries = entryPointFiles(projectRoot());
  assert.ok(entries.includes(`${FEATURE}/src/cli.js`));
  assert.ok(
    entries.includes(`${FEATURE}/util/validate-nginx-upgrade/index.js`),
  );
  assert.ok(!entries.includes(`${FEATURE}/src/cli/program.js`));
});

test("takes the files entry points load as modules", () => {
  const modules = moduleFiles(projectRoot());
  assert.ok(modules.includes(`${FEATURE}/src/cli/program.js`));
  assert.ok(
    modules.includes(`${FEATURE}/util/validate-nginx-upgrade/steps.js`),
  );
  assert.ok(!modules.includes(`${FEATURE}/src/cli.js`));
  assert.ok(modules.every((file) => !file.includes("/src/njs/")));
});

test("takes the njs modules as installed files", () => {
  assert.deepEqual(installedFiles(projectRoot()), [
    `${FEATURE}/src/njs/x1-validator-private-rpc.js`,
  ]);
});

test("every module is loaded by an entry point", async () => {
  const root = projectRoot();
  assert.deepEqual(
    await findUnusedSrcModules(root, entryPointFiles(root), moduleFiles(root)),
    [],
  );
});

test("reports a module the entry points never load", async () => {
  const root = projectRoot();
  const ghost = `${FEATURE}/src/lib/ghost.js`;
  assert.deepEqual(
    await findUnusedSrcModules(root, entryPointFiles(root), [
      ...moduleFiles(root),
      ghost,
    ]),
    [ghost],
  );
});

test("with no entry points, reports every module", async () => {
  assert.deepEqual(
    await findUnusedSrcModules(projectRoot(), [], ["a/src/lib/x.js"]),
    ["a/src/lib/x.js"],
  );
});
