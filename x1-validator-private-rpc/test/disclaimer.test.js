/**
 * @file x1-validator-private-rpc/test/disclaimer.test.js
 * @description
 * Tests the disclaimer's dialog on the fake host, with stand-ins for the
 * terminal: whiptail's arguments, each way it can end, the dialog's size
 * on terminals large and small, and a run without a terminal. Also checks
 * that the feature's README holds the same text the dialog shows.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AFFIRM_BUTTON,
  AFFIRMATION,
  DECLINE_BUTTON,
  DECLINED,
  DISCLAIMER,
  dialogArgs,
  NO_TERMINAL,
  NOT_SHOWN,
  showDisclaimer,
} from "../src/lib/disclaimer.js";
import { createFakeHost } from "./helpers/fake-host.js";

/**
 * Makes stand-ins for a terminal of a given size.
 * @param {number} columns  Its width.
 * @param {number} rows  Its height.
 * @returns {{input: object, output: object}}
 */
function terminalOf(columns, rows) {
  return { input: { isTTY: true }, output: { isTTY: true, columns, rows } };
}

/**
 * Shows the disclaimer on the fake host, where whiptail exits with a
 * given code.
 * @param {number} status  whiptail's exit code.
 * @param {{input: object, output: object}} [terminal]  The terminal.
 * @returns {{refusal: string, calls: object[]}} What showDisclaimer gave,
 *   and the host's calls.
 */
function shown(status, terminal = terminalOf(80, 24)) {
  const host = createFakeHost({ respond: () => ({ status }) });
  return { refusal: showDisclaimer(host, terminal), calls: host.calls };
}

test("the dialog is whiptail's yes-or-no box, with Decline's focus first", () => {
  const { refusal, calls } = shown(0);
  assert.equal(refusal, "");
  assert.deepEqual(calls, [
    {
      kind: "runOnTerminal",
      command: "whiptail",
      args: dialogArgs({ columns: 80, rows: 24 }),
      input: undefined,
    },
  ]);
  const args = calls[0].args;
  for (const [option, value] of [
    ["--title", "Disclaimer"],
    ["--yes-button", AFFIRM_BUTTON],
    ["--no-button", DECLINE_BUTTON],
  ]) {
    assert.equal(args.at(args.indexOf(option) + 1), value, option);
  }
  assert.ok(args.includes("--defaultno"));
  assert.ok(args.includes("--scrolltext"));
  const text = args.at(args.indexOf("--yesno") + 1);
  assert.equal(text, [...DISCLAIMER, AFFIRMATION].join("\n\n"));
  assert.deepEqual(args.slice(-2), ["20", "76"]);
});

test("Decline and Esc decline, and a whiptail that can't run stops the run too", () => {
  assert.equal(shown(1).refusal, DECLINED);
  assert.equal(shown(255).refusal, DECLINED);
  assert.equal(shown(127).refusal, NOT_SHOWN);
});

test("without a terminal, the run can't go on, and no dialog runs", () => {
  for (const terminal of [
    { input: { isTTY: false }, output: { isTTY: true } },
    { input: { isTTY: true }, output: {} },
  ]) {
    const { refusal, calls } = shown(0, terminal);
    assert.equal(refusal, NO_TERMINAL);
    assert.deepEqual(calls, []);
  }
});

test("the dialog fits the terminal, within its smallest and widest", () => {
  const callsAt = (columns, rows) => shown(0, terminalOf(columns, rows)).calls;
  const cases = [
    [200, 60, ["56", "76"]],
    [60, 20, ["16", "56"]],
    [20, 6, ["8", "30"]],
    // A fresh pty reports no size, so the dialog takes 80 by 24.
    [0, 0, ["20", "76"]],
    [undefined, null, ["20", "76"]],
  ];
  for (const [columns, rows, size] of cases) {
    const [call] = callsAt(columns, rows);
    assert.deepEqual(call.args.slice(-2), size, `${columns} by ${rows}`);
  }
});

test("the feature's README holds the disclaimer the dialog shows", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const paragraph of DISCLAIMER) {
    assert.ok(readme.includes(`\n${paragraph}\n`), paragraph);
  }
  assert.ok(readme.includes(`"${AFFIRMATION}"`));
  assert.ok(readme.includes(`choose ${AFFIRM_BUTTON}`));
  assert.ok(readme.includes(`${DECLINE_BUTTON}, or Esc`));
});
