/**
 * @file x1-validator-private-rpc/test/helpers/scripted-prompts.js
 * @description
 * Prompts with scripted answers, for the commands' tests: confirmations
 * and choices answered by the test's functions, passwords handed out in
 * order. Every question and every line said is kept, in order.
 */

/**
 * Makes scripted prompts.
 * @param {object} [script]  The answers.
 * @param {(question: string) => boolean} [script.confirm]  Answers
 *   confirmations; yes unless given.
 * @param {(question: string) => boolean} [script.ask]  Answers choices;
 *   no unless given.
 * @param {string[]} [script.passwords]  The passwords typed, in order.
 * @returns {object} The prompts, with `asked` listing the questions.
 */
export function scriptedPrompts({
  confirm = () => true,
  ask = () => false,
  passwords = [],
} = {}) {
  const asked = [];
  let typed = 0;
  return {
    asked,
    confirm: async (question) => {
      asked.push(question);
      return confirm(question);
    },
    ask: async (question) => {
      asked.push(question);
      return ask(question);
    },
    password: async (prompt) => {
      asked.push(prompt);
      typed += 1;
      return passwords.at(typed - 1) ?? "";
    },
    say: (line) => asked.push(line),
  };
}
