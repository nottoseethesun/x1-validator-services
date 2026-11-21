#!/usr/bin/env node
/**
 * @file scripts/try-deliberate-mistake.js
 * @description
 * Runs one test file in this process, with one deliberate mistake made in
 * a file of a feature's code, for the gate's deliberate mistakes, which
 * scripts/_deliberate-mistakes.js describes. That stage starts it once
 * for each mistake, and once for each test file with no mistake, and
 * hands it its input as json on stdin.
 *
 * Node.js lets a program hook into the loading of modules. Once this
 * script registers its load hook, Node.js hands the hook each file's
 * text after reading it, and compiles the text the hook returns. The
 * hook makes the mistake's edits in the text of the file the input
 * names, so the tests run against the changed code, while the file on
 * disk stays as it was, and a stopped run leaves nothing to undo.
 *
 * It stops at the first failing test, with exit code 1, since one is
 * enough to catch a mistake. Run it with `--help` for its usage.
 */

import { registerHooks } from "node:module";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { APPLIED_PREFIX } from "./_deliberate-mistakes.js";
import { scriptProgram } from "./_tools.js";

/**
 * Reads the run's input from stdin, to its end.
 * @returns {Promise<{file: string, edits: {from: string, to: string}[],
 *   test: string}>} The file to change, or "" for none; its edits; and
 *   the test file. Both paths are absolute.
 */
async function readInput() {
  if (process.stdin.isTTY === true) {
    console.error(
      "This script takes its input on stdin. The gate's deliberate " +
        "mistakes start it, and hand it its input there.",
    );
    process.exit(1);
  }
  let text = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) {
    text += chunk;
  }
  return JSON.parse(text);
}

/**
 * Makes the edits in a file's text.
 * @param {string | ArrayBuffer | Uint8Array} source  The text, as Node.js
 *   read it.
 * @param {{from: string, to: string}[]} edits  The edits.
 * @returns {{text: string, counts: number[]}} The changed text, and how
 *   many times each edit's text was found.
 */
function makeEdits(source, edits) {
  let text =
    typeof source === "string" ? source : new TextDecoder().decode(source);
  const counts = edits.map(({ from, to }) => {
    const count = text.split(from).length - 1;
    text = text.replaceAll(from, to);
    return count;
  });
  return { text, counts };
}

/**
 * Registers the load hook, then runs the test file until a test fails,
 * and on exit reports each edit's count.
 * @returns {Promise<void>}
 */
async function main() {
  scriptProgram(
    "scripts/try-deliberate-mistake.js",
    "Runs one test file with one deliberate mistake made in memory, in a " +
      "file of a feature's code. The gate's deliberate mistakes start it, " +
      "with its input as json on stdin.",
    ["0  every test passed", "1  a test failed, or the input is missing"],
  ).parse();
  const input = await readInput();
  let applied = input.edits.map(() => 0);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:") || fileURLToPath(url) !== input.file) {
        return result;
      }
      const { text, counts } = makeEdits(result.source, input.edits);
      applied = applied.map((count, index) => count + counts.at(index));
      return { ...result, source: text };
    },
  });
  process.on("exit", () => {
    console.error(`${APPLIED_PREFIX}${JSON.stringify(applied)}`);
  });
  const tests = run({ files: [input.test], isolation: "none" });
  tests.on("test:fail", ({ name, details }) => {
    console.log(`✖ ${name}\n${inspect(details?.error)}`);
    process.exit(1);
  });
  tests.resume();
}

main();
