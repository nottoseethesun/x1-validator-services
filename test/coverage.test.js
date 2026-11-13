/**
 * @file test/coverage.test.js
 * @description
 * Tests the gate's coverage verdict on lcov report text alone: how the
 * report is read, and each of the three rules the verdict applies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageVerdict, parseLcov } from "../scripts/_coverage.js";

const REPORT = [
  "TN:",
  "SF:/repo/feature/src/cli/program.js",
  "DA:1,1",
  "LF:10",
  "LH:9",
  "BRF:4",
  "BRH:3",
  "end_of_record",
  "SF:/repo/feature/src/lib/other.js",
  "LF:10",
  "LH:10",
  "BRF:0",
  "BRH:0",
  "end_of_record",
].join("\n");

/**
 * The rules with nothing beyond the overall minimum, for tests to extend.
 * @param {object} [overrides]  Rules to change.
 * @returns {object}
 */
function rules(overrides = {}) {
  return {
    minLinePercent: 80,
    highRiskFiles: [],
    highRiskPercent: 95,
    expectedFiles: [],
    ...overrides,
  };
}

test("reads one record per file, with its line and branch figures", () => {
  assert.deepEqual(parseLcov(REPORT), [
    {
      file: "/repo/feature/src/cli/program.js",
      linesFound: 10,
      linesHit: 9,
      branchesFound: 4,
      branchesHit: 3,
    },
    {
      file: "/repo/feature/src/lib/other.js",
      linesFound: 10,
      linesHit: 10,
      branchesFound: 0,
      branchesHit: 0,
    },
  ]);
});

test("drops a record the report never closes", () => {
  assert.deepEqual(parseLcov("SF:/repo/a.js\nLF:3\nLH:3\n"), []);
});

test("passes when the overall line share meets the minimum", () => {
  const verdict = coverageVerdict(parseLcov(REPORT), rules());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.linePercent, 95);
  assert.deepEqual(verdict.problems, []);
});

test("fails when the overall line share is below the minimum", () => {
  const verdict = coverageVerdict(
    parseLcov(REPORT),
    rules({ minLinePercent: 96 }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, [
    "Line coverage is 95.00%, below the 96% minimum.",
  ]);
});

test("counts a report with nothing to cover as fully covered", () => {
  const verdict = coverageVerdict([], rules());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.linePercent, 100);
});

test("holds a high-risk file to its share for lines and for branches", () => {
  const verdict = coverageVerdict(
    parseLcov(REPORT),
    rules({ highRiskFiles: ["src/cli/program.js"] }),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, [
    "src/cli/program.js: line coverage 90.00%, needs 95%.",
    "src/cli/program.js: branch coverage 75.00%, needs 95%.",
  ]);
});

test("passes a high-risk file that meets its share", () => {
  const verdict = coverageVerdict(
    parseLcov(REPORT),
    rules({ highRiskFiles: ["src/lib/other.js"] }),
  );
  assert.equal(verdict.ok, true);
});

test("fails a high-risk file the report doesn't include", () => {
  const verdict = coverageVerdict(
    parseLcov(REPORT),
    rules({ highRiskFiles: ["src/lib/missing.js"] }),
  );
  assert.deepEqual(verdict.problems, [
    "High-risk file src/lib/missing.js is missing from the coverage report.",
  ]);
});

test("fails an expected module that no test loads", () => {
  const verdict = coverageVerdict(
    parseLcov(REPORT),
    rules({ expectedFiles: ["src/lib/other.js", "src/lib/untested.js"] }),
  );
  assert.deepEqual(verdict.problems, [
    "No test loads src/lib/untested.js, so its coverage is unmeasured.",
  ]);
});
