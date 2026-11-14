/**
 * @file x1-validator-private-rpc/src/cli/ask-password.js
 * @description
 * A prompt on the terminal for a secret, such as the password, that
 * shows nothing of what is typed: LP Ranger's src/lib/ask-password.js,
 * as an ES module. The prompt goes to stderr, so stdout stays clean.
 *
 * Node has no option that hides what is typed, so this gives readline an
 * output that shows nothing. With `terminal: true`, readline turns off
 * the terminal's own echo and edits the line itself, writing each key
 * and each redraw of the line to its output. Here that output drops what
 * it's given, so the keys still edit the line, a backspace or a paste,
 * and none of it reaches the screen. Only the prompt, written to stderr
 * itself, and the line break after the answer appear.
 */

import readline from "node:readline";
import { Writable } from "node:stream";

/**
 * Makes a stream that takes whatever is written to it and shows none of
 * it.
 * @returns {Writable}
 */
function showsNothing() {
  return new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
}

/**
 * Asks for a secret on the terminal, showing nothing of what is typed.
 * @param {string} prompt  Text written before the answer is typed.
 * @param {{input?: import("node:stream").Readable,
 *   output?: import("node:stream").Writable}} [streams]  Where the
 *   answer is typed and where the prompt goes: stdin and stderr, unless a
 *   test passes its own.
 * @returns {Promise<string>} What was typed, without the line end.
 */
export function askPassword(prompt, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stderr;
  return new Promise((resolve) => {
    const lineReader = readline.createInterface({
      input,
      output: showsNothing(),
      terminal: true,
    });
    output.write(prompt);
    lineReader.question("", (answer) => {
      lineReader.close();
      output.write("\n");
      resolve(answer);
    });
  });
}
