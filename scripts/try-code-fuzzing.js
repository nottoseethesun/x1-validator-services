#!/usr/bin/env node
/**
 * @file scripts/try-code-fuzzing.js
 * @description
 * Runs one test file in this process, with one code-fuzzing change made
 * in a file of a feature's code, for the gate's code-fuzzing stage, which
 * scripts/_code-fuzzing.js describes. That stage starts it once for each
 * change, and once for each test file with no change, and hands it its
 * input as json on stdin.
 *
 * Node.js lets a program hook into the loading of modules. Once this
 * script registers its load hook, Node.js hands the hook each file's
 * text after reading it, and compiles the text the hook returns. The
 * hook makes the change's edits in the text of the file the input
 * names, so the tests run against the changed code, while the file on
 * disk stays as it was, and a stopped run leaves nothing to undo.
 *
 * This script may have loaded that file itself before the hook exists,
 * such as the feature's src/lib/node-version.js, which scripts/_tools.js
 * imports. Node.js loads each module's url only once, so its resolve hook
 * gives the file a url of its own, with a query added, and Node.js loads
 * it again, through the load hook, for the test file.
 *
 * It stops at the first failing test, with exit code 1, since one is
 * enough to catch a change. Run it with `--help` for its usage, examples
 * and exit codes.
 */

import nodeModule from "node:module";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { APPLIED_PREFIX } from "./_code-fuzzing.js";
import { requireMinNode, scriptProgram } from "./_tools.js";

/**
 * Reads the run's input from stdin, to its end.
 * @returns {Promise<{file: string, edits: {from: string, to: string}[],
 *   test: string}>} The file to change, or "" for none; its edits; and
 *   the test file. Both paths are absolute.
 */
async function readInput() {
  if (process.stdin.isTTY === true) {
    console.error(
      "This script takes its input on stdin. The gate's code-fuzzing " +
        "stage starts it, and hands it its input there.",
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
    "scripts/try-code-fuzzing.js",
    "Runs one test file with one code-fuzzing change made in memory, in a " +
      "file of a feature's code. scripts/check-code-fuzzing.js, the gate's " +
      "last stage, starts it once for each change, with its input as json " +
      "on stdin.",
    {
      examples: [
        "node scripts/try-code-fuzzing.js < input.json",
        "    Makes the change input.json describes, and runs its test file,",
        "    such as to see a test file's own output for one change.",
        '    input.json holds {"file": ..., "edits": [{"from": ...,',
        '    "to": ...}], "test": ...}, with both paths absolute, and',
        '    "file" "" for a run with no change.',
      ],
      exitCodes: [
        "0  every test passed",
        "1  a test failed, or the input is missing",
      ],
    },
  ).parse();
  requireMinNode("scripts/try-code-fuzzing.js");
  const input = await readInput();
  let applied = input.edits.map(() => 0);
  const isChangedFile = (url) =>
    url.startsWith("file:") && fileURLToPath(url) === input.file;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      return isChangedFile(result.url)
        ? { ...result, url: `${result.url}?code-fuzzing` }
        : result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!isChangedFile(url)) {
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
