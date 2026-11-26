/**
 * @file test/helpers/help-options.js
 * @description
 * Compares a program's help with its usage examples, so that a test can
 * fail a help whose examples don't match its options. `CLAUDE.md`'s
 * "Complete help" asks each help to list every option its program takes,
 * and to give an example of each common use. Each program here declares
 * its options to commander, the package that parses its command line and
 * writes its help, so the help lists every option. The comparison finds
 * two kinds of gap: an option the help lists, other than `--help` and
 * `--version`, that no example uses, by its long or its short form; and
 * an option an example uses that the help doesn't list, such as one
 * misspelt, or one the program no longer takes.
 *
 * It reads the help as commander prints it. The options listed are the
 * lines of the Options section that start with an option, such as
 * "  -y, --yes" or "  --count <n>". An example's command is a line of the
 * Examples section indented by two spaces. The lines indented further
 * explain the command above them, and may name another program's option,
 * such as the validator's --private-rpc, so the comparison leaves them
 * out. Each word of a command that starts with a hyphen and a letter is
 * an option the command uses, up to any "=" in it.
 *
 * test/script-help.test.js uses it for the help of each script in
 * `scripts/` run by its path, and each feature's tests use it for the
 * help of the feature's tool, of each of its commands, and of each of
 * its standalone tools. It sits in the root's `test/helpers/` so that
 * both kinds of test can load it.
 */

/** The options every help lists, which no example needs to use. */
const HELP_AND_VERSION = ["--help", "--version"];

/**
 * The lines of one section of a help: those after its heading, such as
 * "Options:", up to the first blank line.
 * @param {string} help  The help, as commander prints it.
 * @param {string} heading  The section's heading, such as "Examples:".
 * @returns {string[]} The lines, or none when the help has no such
 *   section.
 */
function sectionLines(help, heading) {
  const lines = help.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    return [];
  }
  const end = lines.indexOf("", start);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/**
 * The options a help lists, each as its forms, such as ["-y", "--yes"]
 * or ["--count"], for `--count <n>`.
 * @param {string} help  The help, as commander prints it.
 * @returns {string[][]} The options, in the help's order, or none when
 *   the help has no Options section.
 */
export function listedOptions(help) {
  return sectionLines(help, "Options:")
    .filter((line) => /^ {2}-/.test(line))
    .map(
      (line) =>
        line
          .trim()
          .split(/ {2,}/)[0]
          .match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? [],
    );
}

/**
 * The options a command uses, such as --count in
 * "x1-validator-private-rpc add-api-key --count 3".
 * @param {string} command  The command, as an example gives it.
 * @returns {string[]} The options, or none.
 */
function optionsUsed(command) {
  return command
    .split(/\s+/)
    .filter((word) => /^--?[A-Za-z]/.test(word))
    .map((word) => word.split("=")[0]);
}

/**
 * Finds where a help's options and its examples don't match.
 * @param {string} help  The help, as commander prints it.
 * @param {object} [how]  How to read the examples, when they don't run
 *   the help's own program with its own options.
 * @param {(line: string) => string} [how.runs]  The command an example's
 *   line runs, such as the script and the options an `npm run` target
 *   starts. Unless given, the line itself.
 * @param {(command: string) => string[]} [how.listedFor]  The options
 *   in the help of the command an example runs, each form on its own,
 *   such as `apply`'s options, for an example of `apply` in the tool's
 *   own help. Unless given, the options this help lists.
 * @returns {string[]} One sentence for each gap, or none when the help's
 *   examples use each option it lists, but help and version, and no
 *   other.
 */
export function optionGaps(help, { runs = (line) => line, listedFor } = {}) {
  const listed = listedOptions(help);
  const listedForCommand = listedFor ?? (() => listed.flat());
  const commands = sectionLines(help, "Examples:")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => runs(line.trim()));
  const used = new Set(commands.flatMap(optionsUsed));
  const gaps = listed
    .filter((forms) => !forms.some((form) => HELP_AND_VERSION.includes(form)))
    .filter((forms) => !forms.some((form) => used.has(form)))
    .map((forms) => `No example uses ${forms.join(", ")}.`);
  for (const command of commands) {
    const known = listedForCommand(command);
    for (const option of optionsUsed(command)) {
      if (!known.includes(option)) {
        gaps.push(`${command}: the help doesn't list ${option}.`);
      }
    }
  }
  return gaps;
}
