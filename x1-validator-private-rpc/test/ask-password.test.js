/**
 * @file x1-validator-private-rpc/test/ask-password.test.js
 * @description
 * Tests the password prompt on stand-in streams: it returns what was
 * typed, without the line end, and shows only the prompt and the line
 * break, never what was typed. While it asks, it switches the terminal
 * to raw mode, which turns off the terminal's own echo, and switches it
 * back after. A Ctrl-C at the prompt fails it after a line break, with
 * the terminal switched back.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PROMPT_STOPPED } from "../src/lib/ask-line.js";
import { askPassword } from "../src/lib/ask-password.js";

/**
 * Makes stand-ins for a terminal's input and output.
 * @returns {{input: PassThrough, output: PassThrough, rawModes: boolean[],
 *   shown: () => string}} The streams, each switch to or from raw mode,
 *   which turns the terminal's echo off and on, and what was shown.
 */
function terminal() {
  const input = new PassThrough();
  const rawModes = [];
  input.setRawMode = (on) => {
    rawModes.push(on);
    return input;
  };
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  return { input, output, rawModes, shown: () => shown };
}

test("returns what was typed and shows none of it", async () => {
  const { input, output, rawModes, shown } = terminal();
  const answer = askPassword("Password: ", { input, output });
  input.write("a secret\n");
  assert.equal(await answer, "a secret");
  assert.equal(shown(), "Password: \n");
  assert.deepEqual(rawModes, [true, false]);
});

test("a Ctrl-C at the prompt fails it after a line break, with the terminal's echo back on", async () => {
  const { input, output, rawModes, shown } = terminal();
  /*-
   * The failure is read once the streams have delivered the keys, not
   * awaited, since a prompt left waiting would never settle.
   */
  let failure = "";
  askPassword("The api key: ", { input, output }).catch((error) => {
    failure = error.message;
  });
  input.write("half a key\x03");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure, PROMPT_STOPPED);
  assert.equal(shown(), "The api key: \n");
  assert.deepEqual(rawModes, [true, false]);
});
