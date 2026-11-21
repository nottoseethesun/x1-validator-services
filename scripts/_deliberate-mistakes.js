/**
 * @file scripts/_deliberate-mistakes.js
 * @description
 * The gate's last stage, which proves the tests catch mistakes. Each
 * feature lists deliberate mistakes in its test/deliberate-mistakes.json.
 * An entry names a file of the feature's code, text in that file, what
 * to change the text to, and the test file that must catch the change.
 * The stage makes each mistake in turn, in memory only, and runs that
 * test file. A mistake its test passes is a hole in the tests, and fails
 * the stage.
 *
 * A first pass runs each test file the entries name once, with no
 * mistake, since the verdicts depend on those tests passing as the code
 * stands: a test that fails already would make every mistake look
 * caught. scripts/try-deliberate-mistake.js makes each run, in a process
 * of its own, and stops at the first failing test, since one is enough.
 * The runs go side by side, one per processor.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import { listTestFiles } from "./_test-files.js";
import { projectRoot } from "./_tools.js";

/**
 * @typedef {object} Mistake
 * @property {string} name  What the mistake does, in a few words.
 * @property {string} file  The file it changes, from the feature's folder.
 * @property {{from: string, to: string}[]} edits  The text to change, and
 *   what to change it to. Each `from` is in the file exactly once.
 * @property {string} test  The test file that must fail with the
 *   mistake made, from the feature's folder.
 */

/** Each feature's list of deliberate mistakes, from its folder. */
export const MISTAKES_FILE = "test/deliberate-mistakes.json";

/** How a run starts the line that counts the changes it made. */
export const APPLIED_PREFIX = "deliberate-mistake-applied ";

/** The longest a run may take, in milliseconds, before it's stopped. */
const RUN_TIMEOUT_MS = 300000;

/** How much of a run's output to keep for a report, in characters. */
const OUTPUT_TAIL = 20000;

/**
 * Tells whether a value is a string with something in it.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === "string" && value !== "";
}

/**
 * Tells whether a value is a plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Lists a feature's test files.
 * @param {string} root  The project's root.
 * @param {string} feature  The feature's folder, from the root.
 * @returns {string[]} The test files, from the feature's folder, sorted.
 */
export function featureTestFiles(root, feature) {
  return listTestFiles(root, [path.join(feature, "test")]).map((file) =>
    path.relative(feature, file),
  );
}

/**
 * Reads a feature's deliberate mistakes.
 * @param {string} root  The project's root.
 * @param {string} feature  The feature's folder, from the root.
 * @returns {{mistakes: Mistake[], problems: string[]}} The entries, and
 *   what keeps the file from being read as a list of them.
 */
export function readMistakes(root, feature) {
  const label = `${feature}/${MISTAKES_FILE}`;
  const file = path.join(root, feature, MISTAKES_FILE);
  if (!fs.existsSync(file)) {
    return {
      mistakes: [],
      problems: [`${label} is missing. Each feature lists its mistakes.`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { mistakes: [], problems: [`${label}: ${error.message}`] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { mistakes: [], problems: [`${label} must hold a list of them.`] };
  }
  return { mistakes: parsed, problems: [] };
}

/**
 * Finds what's wrong with one edit of an entry.
 * @param {unknown} edit  The edit.
 * @param {string} file  The entry's file, from the feature's folder.
 * @param {string} text  That file's text.
 * @returns {string[]}
 */
function editProblems(edit, file, text) {
  if (
    !isObject(edit) ||
    !isText(edit.from) ||
    typeof edit.to !== "string" ||
    edit.from === edit.to
  ) {
    return ["each edit needs a from, and a different to"];
  }
  const count = text.split(edit.from).length - 1;
  if (count === 1) {
    return [];
  }
  return [
    `${file} holds this edit's text ${count} times, not once: ${JSON.stringify(edit.from)}`,
  ];
}

/**
 * Finds what's wrong with one entry.
 * @param {string} root  The project's root.
 * @param {string} feature  The feature's folder, from the root.
 * @param {unknown} mistake  The entry.
 * @param {string[]} testFiles  The feature's test files, from its folder.
 * @returns {string[]}
 */
function oneEntryProblems(root, feature, mistake, testFiles) {
  if (!isObject(mistake)) {
    return ["not an object"];
  }
  const problems = isText(mistake.name) ? [] : ["no name"];
  if (!testFiles.includes(mistake.test)) {
    problems.push(`its test, ${mistake.test}, isn't a test file here`);
  }
  if (!isText(mistake.file)) {
    return [...problems, "no file"];
  }
  const filePath = path.join(root, feature, mistake.file);
  if (!fs.existsSync(filePath)) {
    return [...problems, `${mistake.file} isn't there`];
  }
  if (!Array.isArray(mistake.edits) || mistake.edits.length === 0) {
    return [...problems, "no edits"];
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const edit of mistake.edits) {
    problems.push(...editProblems(edit, mistake.file, text));
  }
  return problems;
}

/**
 * Finds what's wrong with a feature's entries: a missing field, a name
 * used twice, a file that isn't there, text that isn't in its file
 * exactly once, or a test that isn't one of the feature's test files.
 * @param {string} root  The project's root.
 * @param {string} feature  The feature's folder, from the root.
 * @param {unknown[]} mistakes  The entries.
 * @param {string[]} testFiles  The feature's test files, from its folder.
 * @returns {string[]} One line per problem.
 */
export function entryProblems(root, feature, mistakes, testFiles) {
  const names = new Set();
  return mistakes.flatMap((mistake, index) => {
    const label = `${feature}/${MISTAKES_FILE}, entry ${index + 1}`;
    const problems = oneEntryProblems(root, feature, mistake, testFiles);
    const name = isObject(mistake) ? mistake.name : undefined;
    if (isText(name) && names.has(name)) {
      problems.push(`the name "${name}" is used twice`);
    }
    names.add(name);
    return problems.map((problem) => `${label}: ${problem}`);
  });
}

/**
 * Runs a task for each item, at most `limit` at a time.
 * @template T, R
 * @param {T[]} items  The items.
 * @param {number} limit  How many tasks may run at once.
 * @param {(item: T) => Promise<R>} task  The task.
 * @returns {Promise<R[]>} The results, in the items' order.
 */
export async function runPool(items, limit, task) {
  const results = new Map();
  const entries = items.entries();
  const worker = async () => {
    for (const [index, item] of entries) {
      results.set(index, await task(item));
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return items.map((_item, index) => results.get(index));
}

/**
 * Reads the counts a run reports for its edits, from its stderr.
 * @param {string} stderr  Everything the run wrote to stderr.
 * @returns {number[]} One count per edit, or none when it reported none.
 */
function appliedCounts(stderr) {
  const line = stderr
    .split("\n")
    .find((entry) => entry.startsWith(APPLIED_PREFIX));
  return line === undefined
    ? []
    : JSON.parse(line.slice(APPLIED_PREFIX.length));
}

/**
 * Starts scripts/try-deliberate-mistake.js for one run, hands it its
 * input on stdin, and waits for it.
 * @param {{file: string, edits: {from: string, to: string}[],
 *   test: string}} input  The file to change, absolute, or "" for none;
 *   its edits; and the test file, absolute.
 * @returns {Promise<{status: number, timedOut: boolean, output: string,
 *   applied: number[]}>} The exit code, whether the run was stopped for
 *   taking too long, the end of its output, and its edits' counts.
 */
function runOnce(input) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(projectRoot(), "scripts", "try-deliberate-mistake.js")],
      { cwd: projectRoot(), stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end(JSON.stringify(input));
    let output = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-OUTPUT_TAIL);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: code ?? 1,
        timedOut,
        output: `${output}${stderr}`.slice(-OUTPUT_TAIL),
        applied: appliedCounts(stderr),
      });
    });
  });
}

/**
 * Makes one mistake, and runs its test file.
 * @param {Mistake} mistake  The entry.
 * @param {string} featureDir  The feature's folder, absolute.
 * @returns {Promise<{mistake: Mistake, verdict: string}>} The verdict:
 *   `caught`, `caught, after timing out`, `missed`, or `not made` when
 *   the test file never loaded the file, so its text wasn't changed.
 */
async function tryMistake(mistake, featureDir) {
  const result = await runOnce({
    file: path.join(featureDir, mistake.file),
    edits: mistake.edits,
    test: path.join(featureDir, mistake.test),
  });
  if (result.timedOut) {
    return { mistake, verdict: "caught, after timing out" };
  }
  if (
    result.applied.length !== mistake.edits.length ||
    result.applied.some((count) => count === 0)
  ) {
    return { mistake, verdict: "not made" };
  }
  return { mistake, verdict: result.status === 0 ? "missed" : "caught" };
}

/**
 * Checks one feature's deliberate mistakes, and prints what went wrong.
 * @param {string} root  The project's root.
 * @param {string} feature  The feature's folder, from the root.
 * @param {{concurrency: number, print: (line: string) => void}} run
 *   How many runs may go at once, and where its lines go.
 * @returns {Promise<{total: number, caught: number, passed: boolean}>}
 */
async function checkFeature(root, feature, { concurrency, print }) {
  const featureDir = path.join(root, feature);
  const read = readMistakes(root, feature);
  const total = read.mistakes.length;
  const problems = [
    ...read.problems,
    ...entryProblems(
      root,
      feature,
      read.mistakes,
      featureTestFiles(root, feature),
    ),
  ];
  if (problems.length > 0) {
    problems.forEach((problem) => print(problem));
    return { total, caught: 0, passed: false };
  }
  const tests = [...new Set(read.mistakes.map((mistake) => mistake.test))];
  const firstRuns = await runPool(tests, concurrency, async (test) => {
    const testPath = path.join(featureDir, test);
    const result = await runOnce({ file: "", edits: [], test: testPath });
    return { test, result };
  });
  const failing = firstRuns.filter(({ result }) => result.status !== 0);
  if (failing.length > 0) {
    for (const { test, result } of failing) {
      print(`${feature}/${test} fails with no mistake made:\n${result.output}`);
    }
    print("The tests must pass before a mistake can show anything.");
    return { total, caught: 0, passed: false };
  }
  const tries = await runPool(read.mistakes, concurrency, (mistake) =>
    tryMistake(mistake, featureDir),
  );
  for (const { mistake, verdict } of tries) {
    if (verdict !== "caught") {
      print(
        `${verdict.toUpperCase()}  ${feature}: ${mistake.name} ` +
          `(${mistake.file}, by ${mistake.test})`,
      );
    }
  }
  const caught = tries.filter(({ verdict }) => verdict.startsWith("caught"));
  return { total, caught: caught.length, passed: caught.length === total };
}

/**
 * Checks every feature's deliberate mistakes, and prints a line for each
 * one its test didn't catch, and a summary.
 * @param {{root: string, features: string[], concurrency: number,
 *   print?: (line: string) => void}} options  The project's root, the
 *   features' folders from it, how many runs may go at once, and where
 *   the lines go, the console unless given.
 * @returns {Promise<boolean>} Whether every mistake failed its test.
 */
export async function checkDeliberateMistakes(options) {
  const { root, features, concurrency } = options;
  const print = options.print ?? ((line) => console.log(line));
  if (typeof nodeModule.registerHooks !== "function") {
    print(
      "The deliberate mistakes need Node.js 22.15 or newer, for its " +
        `module.registerHooks. This is Node.js ${process.versions.node}.`,
    );
    return false;
  }
  const started = Date.now();
  let total = 0;
  let caught = 0;
  let passed = true;
  for (const feature of features) {
    const result = await checkFeature(root, feature, { concurrency, print });
    total += result.total;
    caught += result.caught;
    passed = passed && result.passed;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  print(`Caught ${caught} of ${total} deliberate mistakes, in ${seconds} s.`);
  return passed;
}
