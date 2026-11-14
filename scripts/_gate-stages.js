/**
 * @file scripts/_gate-stages.js
 * @description
 * Every check the gate runs besides the tests and the coverage verdict,
 * written down once as data: a name, a command and its arguments. `npm
 * run lint` runs the lint stages, `npm run check` runs those and the
 * audit stages, and the single-purpose scripts (format, audit) run one
 * stage each. Two npm scripts, knip:files and audit:deps, spell out a
 * stage's command again. The stages take their file lists from
 * scripts/lint-targets.js, but for Prettier's json and yaml globs, here.
 *
 * A stage only describes its command; scripts/lint.js and
 * scripts/check.js run it.
 */

import path from "node:path";
import { toolPath } from "./_tools.js";
import {
  JS_TARGETS,
  MARKDOWN_TARGETS,
  SECRET_TARGETS,
  SECURITY_TARGETS,
} from "./lint-targets.js";

/**
 * @typedef {object} Stage
 * @property {string} name  What the stage checks, for the summary.
 * @property {string} command  The program to run.
 * @property {string[]} args  Its arguments.
 */

/**
 * ESLint with the main rules, failing on any warning.
 * @param {{fix: boolean}} options  Whether to rewrite fixable problems.
 * @returns {Stage}
 */
export function eslintStage({ fix }) {
  const args = [
    ...JS_TARGETS,
    "--max-warnings",
    "0",
    "--no-error-on-unmatched-pattern",
  ];
  return {
    name: "Lint (JavaScript)",
    command: toolPath("eslint"),
    args: fix ? [...args, "--fix"] : args,
  };
}

/**
 * markdownlint over the Markdown files.
 * @param {{fix: boolean}} options  Whether to rewrite fixable problems.
 * @returns {Stage}
 */
export function markdownStage({ fix }) {
  return {
    name: "Lint (Markdown)",
    command: toolPath("markdownlint-cli2"),
    args: fix ? ["--fix", ...MARKDOWN_TARGETS] : [...MARKDOWN_TARGETS],
  };
}

/**
 * Prettier over one kind of file. Prettier formats only JavaScript, json
 * and yaml here, never Markdown, which it would rewrite wholesale.
 * @param {"js"|"json"|"yaml"} kind  Which files.
 * @param {{write: boolean}} options  Rewrite, or only check.
 * @returns {Stage}
 */
export function prettierStage(kind, { write }) {
  const kinds = new Map([
    ["js", { label: "JavaScript", globs: JS_TARGETS }],
    ["json", { label: "json", globs: ["**/*.json"] }],
    ["yaml", { label: "yaml", globs: ["**/*.{yml,yaml}"] }],
  ]);
  const { label, globs } = kinds.get(kind);
  return {
    name: `Format (${label})`,
    command: toolPath("prettier"),
    args: [
      write ? "--write" : "--check",
      "--no-error-on-unmatched-pattern",
      ...globs,
    ],
  };
}

/**
 * actionlint over the GitHub Actions workflows. Run in the project's
 * root with no arguments, it finds them in `.github/workflows` itself.
 * @returns {Stage}
 */
export function actionlintStage() {
  return {
    name: "Lint (GitHub Actions)",
    command: toolPath("github-actionlint"),
    args: [],
  };
}

/**
 * knip, failing on files nothing uses. Unused exports are left alone:
 * they are hooks for tests and tools.
 * @returns {Stage}
 */
export function knipStage() {
  return {
    name: "Dead code (unused files)",
    command: toolPath("knip"),
    args: ["--include", "files"],
  };
}

/**
 * The check that every module under a feature's `src/` is loaded by one
 * of the feature's entry points, not only by tests.
 * @returns {Stage}
 */
export function unusedSrcModulesStage() {
  return {
    name: "Dead code (modules only tests load)",
    command: process.execPath,
    args: [path.join("scripts", "check-unused-src-modules.js")],
  };
}

/**
 * ESLint with the security rules, failing on any warning.
 * @returns {Stage}
 */
export function securityLintStage() {
  return {
    name: "Security lint",
    command: toolPath("eslint"),
    args: [
      "-c",
      "eslint-security.config.js",
      ...SECURITY_TARGETS,
      "--max-warnings",
      "0",
      "--no-error-on-unmatched-pattern",
    ],
  };
}

/**
 * secretlint, the scan for committed credentials.
 * @returns {Stage}
 */
export function secretlintStage() {
  return {
    name: "Secret scan",
    command: toolPath("secretlint"),
    args: [...SECRET_TARGETS],
  };
}

/**
 * Every lint, format and security check that runs on this machine alone,
 * in the order `npm run lint` and `npm run check` run them.
 * @param {{fix: boolean}} options  Rewrite what each tool can fix, or
 *   only check.
 * @returns {Stage[]}
 */
export function lintStages({ fix }) {
  return [
    eslintStage({ fix }),
    markdownStage({ fix }),
    prettierStage("js", { write: fix }),
    prettierStage("json", { write: fix }),
    prettierStage("yaml", { write: fix }),
    actionlintStage(),
    knipStage(),
    unusedSrcModulesStage(),
    securityLintStage(),
    secretlintStage(),
  ];
}

/**
 * The dependency audit of what ships: the runtime dependencies alone,
 * failing on a high or critical advisory.
 * @returns {Stage}
 */
export function auditShippedStage() {
  return {
    name: "Audit (shipped dependencies)",
    command: "npm",
    args: ["audit", "--audit-level=high", "--omit=dev"],
  };
}

/**
 * The dependency audit of the whole tree, dev tools included, as a json
 * report the gate saves without failing on it.
 * @returns {Stage}
 */
export function auditFullReportStage() {
  return {
    name: "Audit (all dependencies, report only)",
    command: "npm",
    args: ["audit", "--json"],
  };
}
