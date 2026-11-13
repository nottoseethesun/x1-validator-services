/**
 * @file test/repo-rules.test.js
 * @description
 * Tests the project rules that live in configuration rather than code,
 * so a change to a configuration file can't quietly drop one: the
 * pre-commit hook runs the lint and nothing else, git ignores the files
 * that hold secrets or disposable output, the main lint fails imports
 * that don't resolve, and the security pass turns on every security
 * rule.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import securityPlugin from "eslint-plugin-security";
import mainConfig from "../eslint.config.js";
import securityConfig, {
  DISABLED_SECURITY_RULES,
} from "../eslint-security.config.js";
import { projectRoot } from "../scripts/_tools.js";
import { JS_TARGETS, SECURITY_TARGETS } from "../scripts/lint-targets.js";

test("the pre-commit hook runs the lint and nothing else", () => {
  const hookUrl = new URL("../.husky/pre-commit", import.meta.url);
  assert.equal(readFileSync(hookUrl, "utf8"), "npm run lint\n");
});

test("git ignores secrets, private notes and disposable output", () => {
  for (const file of [
    ".env",
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
