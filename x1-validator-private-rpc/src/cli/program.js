/**
 * @file x1-validator-private-rpc/src/cli/program.js
 * @description
 * Builds the tool's command-line program with commander. What the tool
 * is for, its version and its options are declared here once, and
 * commander makes both the help text and the parsing from that one
 * declaration, so the two can't drift apart. Commands join the program
 * here as they are written.
 *
 * The program is built inside a function, never as the module loads, so
 * each test can build a fresh one and parse an argument list of its own.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";

const PROGRAM_NAME = "x1-validator-private-rpc";

const PURPOSE =
  "Puts an X1 validator's rpc behind an https url that carries an api " +
  "key, and keeps it that way.";

const EXIT_CODES = [
  "",
  "Exit codes:",
  "  0  success",
  "  1  an error; the reason is printed on stderr",
].join("\n");

/**
 * Reads the project's version from the root package.json, which it finds
 * from this file's own location rather than from the working directory.
 * @returns {string} The version, such as "0.0.0-dev".
 */
export function projectVersion() {
  const packageUrl = new URL("../../../package.json", import.meta.url);
  return JSON.parse(readFileSync(packageUrl, "utf8")).version;
}

/**
 * Builds the tool's command-line program. Its help opens with what the
 * tool is for, lists the options, and ends with the exit codes; asked
 * for, it goes to stdout with exit code 0. Run with no command, the
 * program prints the same help. An unknown option, or an argument the
 * program doesn't take, prints the reason and the help to stderr, with
 * exit code 1.
 * @returns {Command} The program, ready to parse.
 */
export function buildProgram() {
  const program = new Command(PROGRAM_NAME);
  program
    .version(projectVersion(), "-v, --version", "print the version and exit")
    .helpOption("-h, --help", "print this help and exit")
    .addHelpText("beforeAll", `${PURPOSE}\n`)
    .addHelpText("after", EXIT_CODES)
    .showHelpAfterError()
    .action(() => program.help());
  return program;
}

/**
 * Parses an argument list and runs the command it names.
 * @param {string[]} argv  The arguments, as process.argv gives them.
 * @returns {Promise<Command>} The program, once its command has run.
 */
export function runProgram(argv) {
  return buildProgram().parseAsync(argv);
}
