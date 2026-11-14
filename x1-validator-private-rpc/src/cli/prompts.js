/**
 * @file x1-validator-private-rpc/src/cli/prompts.js
 * @description
 * The commands' questions to the person at the terminal. A confirmation,
 * such as whether to go on with a stage, is skipped with --yes, which
 * answers it yes. A choice, such as whether to save the password, and a
 * password prompt are always asked: --yes never answers those. Questions
 * and the lines that go with them go to stderr, so stdout stays clean.
 */

import readline from "node:readline";
import { askPassword } from "./ask-password.js";

/**
 * Asks a yes-or-no question; anything but y or yes is no.
 * @param {string} question  The question.
 * @param {{input: import("node:stream").Readable,
 *   output: import("node:stream").Writable}} streams  Where it's asked.
 * @returns {Promise<boolean>}
 */
function askYesNo(question, { input, output }) {
  return new Promise((resolve) => {
    const lineReader = readline.createInterface({ input, output });
    lineReader.question(`${question} [y/N] `, (answer) => {
      lineReader.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}

/**
 * @typedef {object} Prompts
 * @property {(question: string) => Promise<boolean>} confirm  Asks,
 *   unless --yes answered it already.
 * @property {(question: string) => Promise<boolean>} ask  Always asks.
 * @property {(prompt: string) => Promise<string>} password  Asks for a
 *   secret, showing nothing of what's typed.
 * @property {(line: string) => void} say  Prints a line beside the
 *   questions.
 */

/**
 * Makes the prompts for a run.
 * @param {object} options  How to ask.
 * @param {boolean} options.yes  Whether --yes was given.
 * @param {import("node:stream").Readable} [options.input]  stdin, unless
 *   a test passes its own.
 * @param {import("node:stream").Writable} [options.output]  stderr,
 *   unless a test passes its own.
 * @returns {Prompts}
 */
export function createPrompts({
  yes,
  input = process.stdin,
  output = process.stderr,
}) {
  const streams = { input, output };
  return {
    confirm: async (question) => yes || askYesNo(question, streams),
    ask: (question) => askYesNo(question, streams),
    password: (prompt) => askPassword(prompt, streams),
    say: (line) => output.write(`${line}\n`),
  };
}
