/**
 * @file test/repo-rules.test.js
 * @description
 * Tests the project rules that live in configuration rather than code,
 * so a change to a configuration file can't quietly drop one: the
 * pre-commit hook runs the lint and nothing else, git ignores the files
 * that hold secrets or disposable output, the main lint fails imports
 * that don't resolve, and the security pass turns on every security
 * rule that eslint-security.config.js doesn't turn off with a reason. It
 * also tests that the project has one minimum Node.js version, the one
 * `engines` in package.json names: the scripts accept it and newer, every
 * file that gives a minimum gives that one, and no file names an older
 * major but `x1console`'s 20.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import securityPlugin from "eslint-plugin-security";
import mainConfig from "../eslint.config.js";
import securityConfig, {
  DISABLED_SECURITY_RULES,
} from "../eslint-security.config.js";
import { projectRoot } from "../scripts/_tools.js";
import { JS_TARGETS, SECURITY_TARGETS } from "../scripts/lint-targets.js";
import { featurePaths } from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import {
  meetsOldestNode,
  oldestNode,
  oldestNodeText,
} from "../x1-validator-private-rpc/src/lib/node-version.js";

test("the pre-commit hook runs the lint and nothing else", () => {
  const hookUrl = new URL("../.husky/pre-commit", import.meta.url);
  assert.equal(readFileSync(hookUrl, "utf8"), "npm run lint\n");
});

test("git ignores secrets, private notes and disposable output", () => {
  const paths = featurePaths();
  const featureFiles = [
    paths.envPath,
    paths.statePath,
    paths.whatApplyChangedPath,
    paths.alertStatePath,
    paths.ensureLogPath,
    paths.lockPath,
  ].map((filePath) => path.relative(projectRoot(), filePath));
  for (const file of [
    ...featureFiles,
    "tmp/check/lcov.info",
    "docs/claude/memory/private/owner-machine.md",
    "node_modules/commander/package.json",
  ]) {
    const result = spawnSync("git", ["check-ignore", "--quiet", file], {
      cwd: projectRoot(),
    });
    assert.equal(result.status, 0, `${file} must be ignored`);
  }
});

test("the main lint fails an import that doesn't resolve", () => {
  const block = mainConfig.find((entry) => entry.files === JS_TARGETS);
  assert.equal(block.rules["n/no-missing-import"], "error");
});

test("the security pass turns on every security rule not listed with a reason", () => {
  const block = securityConfig.find(
    (entry) => entry.files === SECURITY_TARGETS,
  );
  for (const name of Object.keys(securityPlugin.rules)) {
    const reason = DISABLED_SECURITY_RULES[name] ?? "";
    const expected = reason === "" ? "warn" : "off";
    assert.equal(block.rules[`security/${name}`], expected, name);
  }
  for (const [name, reason] of Object.entries(DISABLED_SECURITY_RULES)) {
    assert.ok(Object.hasOwn(securityPlugin.rules, name), `${name} exists`);
    assert.ok(reason.length > 0, `${name} has a reason`);
  }
});

test("the scripts' check accepts the oldest Node.js and newer, and nothing older", () => {
  const { major, minor } = oldestNode();
  assert.equal(meetsOldestNode(`${major}.${minor}.0`), true);
  assert.equal(meetsOldestNode(`${major}.${minor + 1}.0`), true);
  assert.equal(meetsOldestNode(`${major + 2}.0.0`), true);
  assert.equal(meetsOldestNode(`${major - 1}.99.0`), false);
  assert.equal(meetsOldestNode("20.0.0"), false);
});

test("every file gives the oldest Node.js as the minimum, and names no older major but x1console's 20", () => {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot(), encoding: "utf8" },
  );
  const files = listed.stdout
    .split("\n")
    .filter((file) => /\.(md|js|json|yml)$/.test(file))
    .filter((file) => file !== "package-lock.json")
    .filter((file) => existsSync(path.join(projectRoot(), file)));
  assert.ok(files.includes("CLAUDE.md"));
  const oldestMajor = oldestNode().major;
  const minimum = `Node.js ${oldestNodeText()} or newer`;
  for (const file of files) {
    const text = readFileSync(path.join(projectRoot(), file), "utf8");
    for (const [named, major] of text.matchAll(/Node\.js (\d+)[.\d]*/g)) {
      const value = Number(major);
      assert.ok(value === 20 || value >= oldestMajor, `${file}: ${named}`);
    }
    for (const [named] of text.matchAll(/Node\.js \d[.\d]* or newer/g)) {
      assert.equal(named, minimum, file);
    }
  }
});
