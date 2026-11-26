/**
 * @file x1-validator-private-rpc/src/lib/ask-line.js
 * @description
 * A prompt on the terminal for one line, which shows what is typed, as
 * askPassword is for a secret. The question goes to stderr, so stdout
 * stays clean. The commands' yes-or-no questions, add-api-key's email and
 * check-my-private-rpc's hostname share it.
 *
 * On a terminal, readline, Node.js's line reader, takes a Ctrl-C at the
 * prompt as a keystroke, and closes without an answer. It closes the same
 * way when the input ends, such as at a Ctrl-D on an empty line. A
 * prompt that waited on would leave the program with nothing more to
 * run, and Node.js would end it with exit code 13 and a warning. So the
 * prompt ends its line, and fails with PROMPT_STOPPED, which lets the
 * program stop with an exit code its help lists.
 */

import readline from "node:readline";

/** Why a prompt failed: it closed before an answer came. */
export const PROMPT_STOPPED =
  "Stopped at a question: Ctrl-C was pressed, or the input ended, before " +
  "an answer came.";

/**
 * Asks one question on the terminal, showing what is typed.
 * @param {string} question  The question.
 * @param {{input?: import("node:stream").Readable,
 *   output?: import("node:stream").Writable}} [streams]  Where the answer
 *   is typed and where the question goes: stdin and stderr, unless a test
 *   passes its own.
 * @returns {Promise<string>} The answer, without the line end.
 * @throws {Error} PROMPT_STOPPED, when Ctrl-C or the input's end closes
 *   the prompt before an answer.
 */
export function askLine(question, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stderr;
  return new Promise((resolve, reject) => {
    const lineReader = readline.createInterface({ input, output });
    let answered = false;
    lineReader.on("close", () => {
      if (answered === false) {
        output.write("\n");
        reject(new Error(PROMPT_STOPPED));
      }
    });
    lineReader.question(question, (answer) => {
      answered = true;
      lineReader.close();
      resolve(answer);
    });
  });
}
