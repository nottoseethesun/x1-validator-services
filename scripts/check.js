#!/usr/bin/env node
/**
 * @file scripts/check.js
 * @description
 * `npm run check`, the one local gate, which must pass before every
 * commit and every push. Every check runs even after one fails, and a
 * summary at the end lists them all.
 *
 * On Node.js 24 or newer it runs the whole gate: the lint, format and
 * security checks of scripts/_gate-stages.js; the audit of the shipped
 * dependencies; a saved audit report of every dependency, dev tools
 * included; the shipped-settings tests; the rest of the suite with
 * coverage; and the coverage verdict of scripts/_coverage.js.
 *
 * On older versions, down to Node.js 20.0.0, it runs the features' tests
 * alone. The lint, coverage and audit tools need Node.js 24, and the
 * tests of the project's own tooling load those tools. The features'
 * tests are the full check of what runs on the validator, whose Node.js
 * is 20.0.0.
 *
 * Reports go to tmp/check/, which is disposable. Run it with `--help` for
 * its usage and exit codes.
 */

import fs from "node:fs";
import path from "node:path";
import { coverageVerdict, parseLcov } from "./_coverage.js";
import {
  auditFullReportStage,
  auditShippedStage,
  lintStages,
} from "./_gate-stages.js";
import { installedFiles, moduleFiles } from "./_project-files.js";
import { printSummary, runStages } from "./_run-stages.js";
import { removeLeftoverTestTempFolders } from "./_test-temp-folders.js";
import {
  listFeatureTestFiles,
  listTestFiles,
  splitConfigValueTests,
} from "./_test-files.js";
import {
  checkScriptArgs,
  projectRoot,
  runCaptured,
  runInherited,
} from "./_tools.js";
import { COVERAGE_TARGETS } from "./lint-targets.js";

const USAGE = `Usage: node scripts/check.js

Runs the gate: on Node.js 24 or newer, every lint, format, security,
audit, test and coverage check; on older versions, the features' tests.

Exit codes:
  0  every check passed
  1  at least one check failed`;

/** The oldest Node.js major version that runs the whole gate. */
const FULL_GATE_NODE_MAJOR = 24;

/** The minimum share of all measured lines the tests must cover. */
const MIN_LINE_PERCENT = 80;

/** The share each high-risk file needs, for lines and for branches. */
const HIGH_RISK_PERCENT = 95;

/**
 * Files held to HIGH_RISK_PERCENT each, as paths from the project's root:
 * the ones whose failure would hurt the validator or leak the api key.
 * They are the api-key check nginx runs; the text of the files the tool
 * installs into nginx, systemd and apt; and the trust in nginx.org's
 * signing key, with the reading of the key files apt already has.
 * @type {string[]}
 */
const HIGH_RISK_FILES = [
  "x1-validator-private-rpc/src/njs/x1-validator-private-rpc.js",
  "x1-validator-private-rpc/src/lib/render-host-files.js",
  "x1-validator-private-rpc/src/lib/nginx-repo.js",
  "x1-validator-private-rpc/src/lib/nginx-org.js",
];

/** Where the gate writes its reports, relative to the project's root. */
const REPORT_DIR = path.join("tmp", "check");

/**
 * Reads the major version of the Node.js running the gate.
 * @returns {number}
 */
function nodeMajor() {
  return Number.parseInt(process.versions.node.split(".")[0], 10);
}

/**
 * Runs one group of tests as a stage of its own. An empty group passes
 * without running: `node --test` with no files would search for tests
 * by itself.
 * @param {string} name  The stage's name.
 * @param {string[]} files  The test files.
 * @param {string[]} options  Extra options for the test runner.
 * @returns {import("./_run-stages.js").StageResult}
 */
function runTestGroup(name, files, options) {
  console.log(`\n── ${name} ──`);
  if (files.length === 0) {
    console.log("No tests in this group.");
    return { name, passed: true };
  }
  const status = runInherited(process.execPath, [
    "--test",
    ...options,
    ...files,
  ]);
  return { name, passed: status === 0 };
}

/**
 * Builds the test runner's coverage options: measure the validator's
 * code alone, print the usual report, and write an lcov report too.
 * @param {string} lcovPath  Where the lcov report goes.
 * @returns {string[]}
 */
function coverageOptions(lcovPath) {
  return [
    "--experimental-test-coverage",
    ...COVERAGE_TARGETS.map((glob) => `--test-coverage-include=${glob}`),
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
  ];
}

/**
 * Judges the lcov report and prints the result.
 * @param {string} root  The project's root.
 * @param {string} lcovPath  The lcov report.
 * @returns {import("./_run-stages.js").StageResult}
 */
function judgeCoverage(root, lcovPath) {
  const name = "Coverage";
  console.log(`\n── ${name} ──`);
  if (!fs.existsSync(lcovPath)) {
    console.error("The test run wrote no coverage report.");
    return { name, passed: false };
  }
  const verdict = coverageVerdict(
    parseLcov(fs.readFileSync(lcovPath, "utf8")),
    {
      minLinePercent: MIN_LINE_PERCENT,
      highRiskFiles: HIGH_RISK_FILES,
      highRiskPercent: HIGH_RISK_PERCENT,
      expectedFiles: [...moduleFiles(root), ...installedFiles(root)],
    },
  );
  console.log(`Line coverage: ${verdict.linePercent.toFixed(2)}%`);
  for (const problem of verdict.problems) {
    console.error(problem);
  }
  return { name, passed: verdict.ok };
}

/**
 * Runs the shipped-settings tests, then the rest of the suite.
 * @param {string} root  The project's root.
 * @param {{coverage: boolean}} options  Whether to measure coverage, and
 *   run the tooling's tests too.
 * @returns {import("./_run-stages.js").StageResult[]}
 */
function runTests(root, { coverage }) {
  const files = coverage ? listTestFiles(root) : listFeatureTestFiles(root);
  const { configValues, others } = splitConfigValueTests(files);
  const lcovPath = path.join(root, REPORT_DIR, "lcov.info");
  fs.rmSync(lcovPath, { force: true });
  const results = [
    runTestGroup("Tests (shipped settings)", configValues, []),
    runTestGroup("Tests", others, coverage ? coverageOptions(lcovPath) : []),
  ];
  if (coverage) {
    results.push(judgeCoverage(root, lcovPath));
  }
  return results;
}

/**
 * Audits every dependency, dev tools included, and saves the json report
 * without failing on it: only the shipped dependencies decide the gate.
 * @param {string} root  The project's root.
 * @returns {import("./_run-stages.js").StageResult}
 */
function saveFullAudit(root) {
  const stage = auditFullReportStage();
  console.log(`\n── ${stage.name} ──`);
  const result = runCaptured(stage.command, stage.args);
  const reportPath = path.join(root, REPORT_DIR, "npm-audit-all.json");
  fs.writeFileSync(reportPath, result.stdout);
  console.log(`Saved to ${path.relative(root, reportPath)}.`);
  return { name: stage.name, passed: true };
}

/**
 * Runs the gate for the running Node.js version and exits with the
 * verdict.
 */
function main() {
  checkScriptArgs(process.argv.slice(2), [], USAGE);
  const root = projectRoot();
  fs.mkdirSync(path.join(root, REPORT_DIR), { recursive: true });
  for (const folder of removeLeftoverTestTempFolders()) {
    console.log(`Removed a dead test run's folder: ${folder}`);
  }
  let results;
  if (nodeMajor() >= FULL_GATE_NODE_MAJOR) {
    results = runStages([...lintStages({ fix: false }), auditShippedStage()]);
    results.push(saveFullAudit(root));
    results.push(...runTests(root, { coverage: true }));
  } else {
    console.log(
      `Node.js ${process.versions.node}: running the features' tests ` +
        `only. The whole gate needs Node.js ${FULL_GATE_NODE_MAJOR}.`,
    );
    results = runTests(root, { coverage: false });
  }
  process.exit(printSummary(results) ? 0 : 1);
}

main();
