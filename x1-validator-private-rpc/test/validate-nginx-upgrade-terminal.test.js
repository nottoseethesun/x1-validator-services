/**
 * @file x1-validator-private-rpc/test/validate-nginx-upgrade-terminal.test.js
 * @description
 * Tests how the nginx upgrade check talks to the person at the terminal:
 * its progress lines, the spinner beside a long step, its answer to
 * Ctrl-C, and the outcome with its exit code. The process, its stdout
 * and the spinner are stand-ins, and console's output is captured.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  createTerminal,
  reportOutcome,
} from "../util/validate-nginx-upgrade/terminal.js";

const PREFIX = "[validate-nginx-upgrade]";

/**
 * Builds a terminal on stand-ins, and captures what it prints.
 * @param {import("node:test").TestContext} t  The test, for its mocks.
 * @param {{isTTY?: boolean, columns?: number}} stdout  The stand-in
 *   output stream.
 * @returns {{terminal: object, signals: EventEmitter, made: object[],
 *   printed: string[]}} The terminal; its Ctrl-C source; the options of
 *   each spinner made; and every line printed and spinner call, in order.
 */
function terminalOn(t, stdout) {
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  const signals = new EventEmitter();
  const made = [];
  const makeSpinner = (options) => {
    made.push(options);
    return Object.fromEntries(
      ["start", "clear", "render", "stopAndPersist"].map((name) => [
        name,
        (arg) => printed.push(arg === undefined ? name : { [name]: arg }),
      ]),
    );
  };
  const terminal = createTerminal({ stdout, signals, makeSpinner });
  return { terminal, signals, made, printed };
}

test("Ctrl-C is noticed once, and says what happens next", (t) => {
  const { terminal, signals, printed } = terminalOn(t, { isTTY: false });
  assert.equal(terminal.isInterrupted(), false);
  signals.emit("SIGINT");
  signals.emit("SIGINT");
  assert.equal(terminal.isInterrupted(), true);
  assert.deepEqual(printed, [
    `${PREFIX} Ctrl-C: stopping after this step, then removing everything ` +
      "the check added.",
  ]);
});

test("without a terminal that reports its width, a long step prints its line and runs", async (t) => {
  for (const stdout of [{ isTTY: false }, { isTTY: true, columns: 0 }]) {
    const { terminal, made, printed } = terminalOn(t, stdout);
    assert.equal(await terminal.wait("Installing.", async () => 7), 7);
    assert.deepEqual(made, []);
    assert.deepEqual(printed.at(-1), `${PREFIX} Installing.`);
  }
});

test("on a terminal, a long step spins, and progress prints around the spinner", async (t) => {
  const stdout = { isTTY: true, columns: 80 };
  const { terminal, made, printed } = terminalOn(t, stdout);
  const answer = await terminal.wait("Installing.", async () => {
    terminal.report("Still going.");
    return 7;
  });
  assert.equal(answer, 7);
  assert.deepEqual(made, [{ text: `${PREFIX} Installing.`, stream: stdout }]);
  assert.deepEqual(printed, [
    "start",
    "clear",
    `${PREFIX} Still going.`,
    "render",
    { stopAndPersist: { symbol: "" } },
  ]);
  terminal.report("Done.");
  assert.equal(printed.at(-1), `${PREFIX} Done.`);
});

test("the spinner stops when the step fails, and the failure goes on", async (t) => {
  const { terminal, printed } = terminalOn(t, { isTTY: true, columns: 80 });
  await assert.rejects(
    terminal.wait("Installing.", async () => {
      throw new Error("apt failed");
    }),
    { message: "apt failed" },
  );
  assert.deepEqual(printed.at(-1), { stopAndPersist: { symbol: "" } });
});

test("a pass is reported, with exit code 0", () => {
  const reported = [];
  const code = reportOutcome(
    { passed: true, problems: [], leftovers: [] },
    (line) => reported.push(line),
  );
  assert.equal(code, 0);
  assert.deepEqual(reported, [
    "Passed: an apt upgrade of nginx keeps the gated rpc unlocked.",
  ]);
});

test("a failure lists each problem on stderr, with exit code 1", (t) => {
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const code = reportOutcome(
    { passed: false, problems: ["One.", "Two."], leftovers: [] },
    () => assert.fail("a failure isn't a progress line"),
  );
  assert.equal(code, 1);
  assert.deepEqual(errors, [
    `${PREFIX} One.`,
    `${PREFIX} Two.`,
    `${PREFIX} Failed. The check removed everything it added.`,
  ]);
});

test("what the check couldn't undo is listed line by line, with what to do", (t) => {
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const code = reportOutcome(
    {
      passed: false,
      problems: [],
      leftovers: ['Couldn\'t finish "X": it failed\n  By hand: sudo x'],
    },
    () => {},
  );
  assert.equal(code, 1);
  assert.deepEqual(errors, [
    `${PREFIX} Couldn't finish "X": it failed`,
    `${PREFIX}   By hand: sudo x`,
    `${PREFIX} Failed, and some of what the check added is still in place, ` +
      'as listed above. Run each "By hand" command, in the order listed, ' +
      "then run the check again.",
  ]);
});
