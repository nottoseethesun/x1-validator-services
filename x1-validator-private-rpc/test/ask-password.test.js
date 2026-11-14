/**
 * @file x1-validator-private-rpc/test/ask-password.test.js
 * @description
 * Tests the password prompt on stand-in streams: it returns what was
 * typed, without the line end, and shows only the prompt and the line
 * break, never what was typed.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askPassword } from "../src/cli/ask-password.js";

test("returns what was typed and shows none of it", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  const answer = askPassword("Password: ", { input, output });
  input.write("a secret\n");
  assert.equal(await answer, "a secret");
  assert.equal(shown, "Password: \n");
});
