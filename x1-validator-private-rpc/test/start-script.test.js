/**
 * @file x1-validator-private-rpc/test/start-script.test.js
 * @description
 * Tests the start-script edit on fixtures/start_validator.sh, which has
 * the shape of x1console's script, and on variants made from it: already
 * edited, with the flag on a line of its own, with no port line or two,
 * and binding the rpc elsewhere. The edit changes one line, changes
 * nothing on a second run, refuses each bad layout, and its removal
 * gives back the original bytes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addPrivateRpc,
  readStartScript,
  removePrivateRpc,
} from "../src/cli/start-script.js";

// Any path will do: the edit only names it in its messages.
const SCRIPT_PATH = "/srv/console/start.sh";
const PORT_LINE = "    --rpc-port 8899 \\";

/**
 * Reads the fixture script.
 * @returns {string}
 */
function fixture() {
  return fs.readFileSync(
    fileURLToPath(new URL("fixtures/start_validator.sh", import.meta.url)),
    "utf8",
  );
}

/**
 * Makes a variant of the fixture by replacing one piece of text.
 * @param {string} from  Text the fixture holds once.
 * @param {string} to  Its replacement.
 * @returns {string}
 */
function variant(from, to) {
  const text = fixture();
  assert.equal(text.split(from).length, 2, `the fixture holds ${from} once`);
  return text.replace(from, to);
}

test("reads the rpc port from its line, and sees no flag yet", () => {
  assert.deepEqual(readStartScript(fixture(), SCRIPT_PATH), {
    rpcPort: 8899,
    hasFlag: false,
    portLine: fixture().split("\n").indexOf(PORT_LINE),
  });
  const otherPort = variant(PORT_LINE, "    --rpc-port 9999 \\");
  assert.equal(readStartScript(otherPort, SCRIPT_PATH).rpcPort, 9999);
});

test("the edit changes the port line alone, and a second run changes nothing", () => {
  const original = fixture();
  const edited = addPrivateRpc(original, SCRIPT_PATH);
  assert.equal(edited.changed, true);
  const before = original.split("\n");
  const after = edited.text.split("\n");
  const changedLines = after.filter((line, index) => line !== before[index]);
  assert.deepEqual(changedLines, ["    --rpc-port 8899 --private-rpc \\"]);
  assert.equal(after.length, before.length);
  assert.deepEqual(addPrivateRpc(edited.text, SCRIPT_PATH), {
    text: edited.text,
    changed: false,
  });
  assert.equal(readStartScript(edited.text, SCRIPT_PATH).hasFlag, true);
});

test("removing the flag gives back the original bytes", () => {
  const original = fixture();
  const { text } = addPrivateRpc(original, SCRIPT_PATH);
  assert.deepEqual(removePrivateRpc(text, SCRIPT_PATH), {
    text: original,
    changed: true,
  });
  assert.deepEqual(removePrivateRpc(original, SCRIPT_PATH), {
    text: original,
    changed: false,
  });
});

test("a flag on a line of its own is left alone, and isn't taken away", () => {
  const ownLine = variant(PORT_LINE, `${PORT_LINE}\n    --private-rpc \\`);
  assert.deepEqual(addPrivateRpc(ownLine, SCRIPT_PATH), {
    text: ownLine,
    changed: false,
  });
  assert.deepEqual(removePrivateRpc(ownLine, SCRIPT_PATH), {
    text: ownLine,
    changed: false,
  });
});

test("refuses a script with no port line, or with two", () => {
  const expected = new RegExp(
    `^${SCRIPT_PATH} must hold exactly one line of the form "--rpc-port N \\\\"`,
  );
  for (const [text, count] of [
    [variant(PORT_LINE, "    --rpc-port 8899 --full-rpc-api \\"), 0],
    [variant(PORT_LINE, `${PORT_LINE}\n${PORT_LINE}`), 2],
  ]) {
    assert.throws(() => addPrivateRpc(text, SCRIPT_PATH), {
      message: new RegExp(`${expected.source}.* it holds ${count}\\.`),
    });
  }
});

test("refuses a command that binds the rpc to another address", () => {
  for (const flag of [
    "--rpc-bind-address 0.0.0.0",
    "--rpc-bind-address=203.0.113.10",
  ]) {
    const text = variant(PORT_LINE, `${PORT_LINE}\n    ${flag} \\`);
    assert.throws(() => addPrivateRpc(text, SCRIPT_PATH), {
      message:
        /binds the rpc to .* with --rpc-bind-address, so --private-rpc wouldn't keep it on 127\.0\.0\.1/,
    });
  }
  const loopback = variant(
    PORT_LINE,
    `${PORT_LINE}\n    --rpc-bind-address 127.0.0.1 \\`,
  );
  assert.equal(addPrivateRpc(loopback, SCRIPT_PATH).changed, true);
});

test("finds the command by its tachyon-validator line, not by a comment", () => {
  const commented = variant(
    "# Start the validator",
    "# Runs tachyon-validator --rpc-bind-address 0.0.0.0 here, in a comment",
  );
  assert.equal(addPrivateRpc(commented, SCRIPT_PATH).changed, true);
  const noCommand = fixture().replaceAll("tachyon-validator", "other-program");
  assert.throws(() => readStartScript(noCommand, SCRIPT_PATH), {
    message: /has no line that runs tachyon-validator/,
  });
});

test("refuses to remove the flag when two port lines carry it", () => {
  const flagged = "    --rpc-port 8899 --private-rpc \\";
  const text = variant(PORT_LINE, `${flagged}\n${flagged}`);
  assert.throws(() => removePrivateRpc(text, SCRIPT_PATH), {
    message: /holds 2 port lines with --private-rpc/,
  });
});
