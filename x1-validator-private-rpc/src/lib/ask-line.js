/**
 * @file x1-validator-private-rpc/src/lib/ask-line.js
 * @description
 * A prompt on the terminal for one line, which shows what is typed, as
 * askPassword is for a secret. The question goes to stderr, so stdout
 * stays clean. The commands' yes-or-no questions, add-api-key's email and
 * check-my-private-rpc's hostname share it.
 */

import readline from "node:readline";

/**
 * Asks one question on the terminal, showing what is typed.
 * @param {string} question  The question.
 * @param {{input?: import("node:stream").Readable,
 *   output?: import("node:stream").Writable}} [streams]  Where the answer
 *   is typed and where the question goes: stdin and stderr, unless a test
 *   passes its own.
 * @returns {Promise<string>} The answer, without the line end.
 */
export function askLine(question, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stderr;
  return new Promise((resolve) => {
    const lineReader = readline.createInterface({ input, output });
    lineReader.question(question, (answer) => {
      lineReader.close();
      resolve(answer);
    });
  });
}
