/**
 * @file test/code-fuzzing.test.js
 * @description
 * Tests the gate's code-fuzzing stage, scripts/_code-fuzzing.js:
 *
 * - each feature's list is well formed, and each entry's text is in its
 *   file exactly once, so a change to the code that leaves an entry with
 *   nothing to change fails the tests at once, without the stage
 * - each kind of problem in an entry, or in the list's file, is named
 * - the runs keep their items' order, and no more run at once than asked
 * - on a small feature made for the test, a change its test catches
 *   passes, while a change its test misses, one its test never loads,
 *   and a test that fails with no change made each fail the stage
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CHANGES_FILE,
  checkCodeFuzzing,
  entryProblems,
  featureTestFiles,
  readChanges,
  runPool,
} from "../scripts/_code-fuzzing.js";
import { makeTestTempFolder } from "../scripts/_test-temp-folders.js";
import { projectRoot } from "../scripts/_tools.js";
import { FEATURES } from "../scripts/lint-targets.js";

/** The made-up feature's code: one function tested, one not. */
const SUM_SOURCE = [
  "export function sum(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export function label() {",
  '  return "sum";',
  "}",
  "",
].join("\n");

/**
 * Makes a project with one small feature, `feat`, whose test checks
 * `sum` and nothing else, and a second test that loads no code.
 * @param {object[]} changes  The feature's code-fuzzing changes.
 * @param {{expected?: number}} [options]  The sum the test expects, 5
 *   unless given.
 * @returns {string} The project's root.
 */
function makeProject(changes, { expected = 5 } = {}) {
  const root = makeTestTempFolder("code-fuzzing");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{ "type": "module" }\n');
  write("feat/src/sum.js", SUM_SOURCE);
  write(
    "feat/test/sum.test.js",
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { sum } from "../src/sum.js";',
      "",
      `test("adds", () => assert.equal(sum(2, 3), ${expected}));`,
      "",
    ].join("\n"),
  );
  write(
    "feat/test/other.test.js",
    'import { test } from "node:test";\n\ntest("passes", () => {});\n',
  );
  write(`feat/${CHANGES_FILE}`, JSON.stringify(changes));
  return root;
}

/**
 * Runs the stage on a made-up project, collecting what it prints.
 * @param {string} root  The project's root.
 * @returns {Promise<{passed: boolean, lines: string[]}>}
 */
async function check(root) {
  const lines = [];
  const passed = await checkCodeFuzzing({
    root,
    features: ["feat"],
    concurrency: 2,
    print: (line) => lines.push(line),
  });
  return { passed, lines };
}

const CAUGHT = {
  name: "sum subtracts",
  file: "src/sum.js",
  edits: [{ from: "a + b", to: "a - b" }],
  test: "test/sum.test.js",
};

test("each feature's list is well formed, and each entry's text is in its file exactly once", () => {
  const root = projectRoot();
  for (const feature of FEATURES) {
    const { changes, problems } = readChanges(root, feature);
    const testFiles = featureTestFiles(root, feature);
    assert.deepEqual(
      [...problems, ...entryProblems(root, feature, changes, testFiles)],
      [],
    );
    assert.ok(changes.length > 0, feature);
  }
});

test("each kind of problem in an entry is named", () => {
  const root = makeProject([]);
  const ok = { file: "src/sum.js", test: "test/sum.test.js" };
  const edit = [{ from: "a + b", to: "a - b" }];
  const entries = [
    "not an entry",
    { ...ok, name: "", edits: edit },
    { ...ok, name: "missing file", file: "src/none.js", edits: edit },
    { ...ok, name: "no edits", edits: [] },
    { ...ok, name: "same text", edits: [{ from: "a + b", to: "a + b" }] },
    { ...ok, name: "not there", edits: [{ from: "a * b", to: "a / b" }] },
    { ...ok, name: "twice", edits: [{ from: "return", to: "throw" }] },
    { ...ok, name: "no test", edits: edit, test: "test/none.test.js" },
    { ...ok, name: "twice named", edits: edit },
    { ...ok, name: "twice named", edits: edit },
  ];
  const testFiles = featureTestFiles(root, "feat");
  assert.deepEqual(testFiles, ["test/other.test.js", "test/sum.test.js"]);
  const label = `feat/${CHANGES_FILE}, entry`;
  assert.deepEqual(entryProblems(root, "feat", entries, testFiles), [
    `${label} 1: not an object`,
    `${label} 2: no name`,
    `${label} 3: src/none.js isn't there`,
    `${label} 4: no edits`,
    `${label} 5: each edit needs a from, and a different to`,
    `${label} 6: src/sum.js holds this edit's text 0 times, not once: "a * b"`,
    `${label} 7: src/sum.js holds this edit's text 2 times, not once: "return"`,
    `${label} 8: its test, test/none.test.js, isn't a test file here`,
    `${label} 10: the name "twice named" is used twice`,
  ]);
});

test("a list's file that's missing, isn't json, or holds an empty list is named", () => {
  const root = makeProject([]);
  const listPath = path.join(root, "feat", CHANGES_FILE);
  const label = `feat/${CHANGES_FILE}`;
  assert.deepEqual(readChanges(root, "feat").problems, [
    `${label} must hold a list of code-fuzzing changes, with at least one entry.`,
  ]);
  fs.writeFileSync(listPath, "[");
  assert.match(readChanges(root, "feat").problems.join(), /JSON/);
  fs.rmSync(listPath);
  assert.deepEqual(readChanges(root, "feat").problems, [
    `${label} is missing. Each feature lists its code-fuzzing changes.`,
  ]);
});

test("the runs keep their items' order, and no more run at once than asked", async () => {
  let running = 0;
  let most = 0;
  const results = await runPool([30, 10, 20, 0], 2, async (ms) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1;
    return ms * 2;
  });
  assert.deepEqual(results, [60, 20, 40, 0]);
  assert.equal(most, 2);
});

test("a change its test catches passes the stage", async () => {
  const { passed, lines } = await check(makeProject([CAUGHT]));
  assert.equal(passed, true);
  assert.match(
    lines.join("\n"),
    /^Caught 1 of 1 code-fuzzing changes, in \d+ s\.$/,
  );
});

test("a change its test misses, or a test that never loads its file, fails the stage", async () => {
  const missed = {
    name: "label changes",
    file: "src/sum.js",
    edits: [{ from: '"sum"', to: '"add"' }],
    test: "test/sum.test.js",
  };
  const notLoaded = {
    ...CAUGHT,
    name: "never loaded",
    test: "test/other.test.js",
  };
  const { passed, lines } = await check(
    makeProject([CAUGHT, missed, notLoaded]),
  );
  assert.equal(passed, false);
  assert.deepEqual(lines.slice(0, 2), [
    "MISSED  feat: label changes (src/sum.js, by test/sum.test.js)",
    "NOT MADE  feat: never loaded (src/sum.js, by test/other.test.js)",
  ]);
  assert.match(lines.at(-1), /^Caught 1 of 3 code-fuzzing changes/);
});

test("a test that fails with no change made fails the stage before any change", async () => {
  const { passed, lines } = await check(makeProject([CAUGHT], { expected: 6 }));
  assert.equal(passed, false);
  assert.match(
    lines.at(0),
    /^feat\/test\/sum\.test\.js fails with no change made:/,
  );
  assert.equal(
    lines.at(1),
    "The tests must pass before a change can show anything.",
  );
  assert.match(lines.at(-1), /^Caught 0 of 1 code-fuzzing changes/);
});
