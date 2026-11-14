/**
 * @file x1-validator-private-rpc/src/cli/program.js
 * @description
 * Builds the tool's command-line program with commander. What the tool
 * is for, its version, its commands and their options are declared here
 * once, and commander makes both the help text and the parsing from that
 * one declaration, so the two can't drift apart.
 *
 * The program is built inside a function, never as the module loads, so
 * each test can build a fresh one and parse an argument list of its own.
 * What the commands work with, the host, the settings, the prompts and
 * the output, comes from a set of makers that the real run creates when
 * a command starts, and that tests replace with stand-ins.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { createHost } from "../lib/host.js";
import { loadSettings, overrideFilePath } from "../lib/settings.js";
import { runApply } from "./apply.js";
import { runEnsure } from "./ensure.js";
import { featurePaths } from "./feature-paths.js";
import { runDecryptKey, runUnlock, runUrl } from "./key-commands.js";
import { createLog } from "./log.js";
import { createPrompts } from "./prompts.js";
import {
  runTurnOffPrivateRpc,
  runTurnOnPrivateRpc,
} from "./turn-private-rpc.js";
import { runUndoApply } from "./undo-apply.js";

const PROGRAM_NAME = "x1-validator-private-rpc";

const PURPOSE =
  "Puts an X1 validator's rpc behind an https url that carries an api " +
  "key, and keeps it that way.";

/** The exit codes, as the help shows them, after the options. */
export const EXIT_CODES = [
  "",
  "Exit codes:",
  "  0  success, or every check ok",
  "  1  a stage failed, a check found a problem, you answered no and the",
  "     command stopped, or another error, and the output says which",
].join("\n");

/**
 * Reads the project's version from the root package.json, which it finds
 * from this file's own location rather than from the working directory.
 * @returns {string} The version, such as "0.0.0-dev".
 */
export function projectVersion() {
  const packageUrl = new URL("../../../package.json", import.meta.url);
  const text = readFileSync(packageUrl, "utf8");
  return JSON.parse(text).version;
}

/**
 * @typedef {object} Makers
 * @property {() => object} host  Makes the host.
 * @property {() => object} settings  Loads the settings.
 * @property {() => string} overridePath  Finds the operator's file.
 * @property {() => object} paths  Finds the feature's own paths.
 * @property {() => import("./log.js").Log} log  Makes the logger.
 * @property {(yes: boolean) => import("./prompts.js").Prompts} prompts
 *   Makes the prompts.
 * @property {(line: string) => void} out  Prints a line on stdout.
 * @property {(line: string) => void} err  Prints a line on stderr.
 * @property {(text: string) => void} write  Writes to stdout as is.
 * @property {() => string} stdin  Reads stdin whole.
 * @property {() => boolean} stdoutIsTerminal  Whether stdout is one.
 * @property {(code: number) => void} setExitCode  Sets the exit code.
 */

/**
 * Makes the real run's makers.
 * @returns {Makers}
 */
export function realMakers() {
  return {
    host: () => createHost(),
    settings: () => loadSettings(),
    overridePath: () => overrideFilePath(),
    paths: () => featurePaths(),
    log: () => createLog(),
    prompts: (yes) => createPrompts({ yes }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    write: (text) => process.stdout.write(text),
    stdin: () => readFileSync(0, "utf8"),
    stdoutIsTerminal: () => process.stdout.isTTY === true,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

/**
 * Makes a command's action. It gathers what the command works with, runs
 * it, and sets the exit code. An error prints its reason on stderr and
 * exits 1, without a stack trace.
 * @param {Makers} makers  The makers.
 * @param {string} name  The command.
 * @param {(run: object) => Promise<number>} work  The command's work.
 * @returns {(options: object) => Promise<void>}
 */
function action(makers, name, work) {
  return async (options) => {
    const log = makers.log();
    let code;
    try {
      const run = {
        host: makers.host(),
        settings: makers.settings(),
        overridePath: makers.overridePath(),
        paths: makers.paths(),
        log,
        prompts: makers.prompts(options.yes === true),
        out: makers.out,
        err: makers.err,
        options,
      };
      code = await work(run);
    } catch (error) {
      log.problem(name, error.message);
      code = 1;
    }
    makers.setExitCode(code);
  };
}

/**
 * Adds the commands to the program.
 * @param {Command} program  The program.
 * @param {Makers} makers  The makers.
 */
function addCommands(program, makers) {
  program
    .command("apply")
    .description(
      "make the rpc private and put it behind nginx, asking before each stage",
    )
    .option("-y, --yes", "skip the confirmations, never a password or a choice")
    .option("--dry-run", "print every change apply would make, and make none")
    .option(
      "--acme-staging",
      "get the certificate from Let's Encrypt's staging service, for a first run",
    )
    .action(action(makers, "apply", runApply));
  program
    .command("ensure")
    .description(
      "put --private-rpc back after an update, check the setup and send alerts",
    )
    .option("-q, --quiet", "print only what changed and the alerts sent")
    .option(
      "--from-git-hook",
      "run without waiting out an update, as git's hook",
    )
    .action(action(makers, "ensure", runEnsure));
  program
    .command("undo-apply")
    .description("undo what apply did, newest step first")
    .option("--dry-run", "print every step, and change nothing")
    .action(action(makers, "undo-apply", runUndoApply));
  program
    .command("turn-off-private-rpc")
    .description(
      "take --private-rpc out of the start script, and keep ensure from putting it back",
    )
    .option("-y, --yes", "skip the confirmation")
    .action(action(makers, "turn-off-private-rpc", runTurnOffPrivateRpc));
  program
    .command("turn-on-private-rpc")
    .description(
      "put --private-rpc back into the start script, for ensure to keep there",
    )
    .action(action(makers, "turn-on-private-rpc", runTurnOnPrivateRpc));
  program
    .command("unlock")
    .description("ask for the password, and restart nginx with the key")
    .action(action(makers, "unlock", runUnlock));
  program
    .command("url")
    .description("ask for the password, and print the rpc's full urls")
    .action(action(makers, "url", runUrl));
  program
    .command("decrypt-key", { hidden: true })
    .requiredOption("--password-stdin", "read the password from stdin")
    .action(
      action(makers, "decrypt-key", (run) => {
        const decryptRun = {
          ...run,
          stdinText: makers.stdin(),
          stdoutIsTerminal: makers.stdoutIsTerminal(),
          write: makers.write,
        };
        return runDecryptKey(decryptRun);
      }),
    );
}

/**
 * Builds the tool's command-line program. Its help opens with what the
 * tool is for, lists the commands and options, and ends with the exit
 * codes. Asked for, the help goes to stdout with exit code 0. Run with no
 * command, the program prints the same help. An unknown option or
 * command prints the reason and the help to stderr, with exit code 1.
 * @param {Makers} [makers]  What the commands work with: the real run's,
 *   unless a test passes stand-ins.
 * @returns {Command} The program, ready to parse.
 */
export function buildProgram(makers = realMakers()) {
  const program = new Command(PROGRAM_NAME);
  const version = projectVersion();
  program
    .version(version, "-v, --version", "print the version and exit")
    .helpOption("-h, --help", "print this help and exit")
    .addHelpText("beforeAll", `${PURPOSE}\n`)
    .addHelpText("after", EXIT_CODES)
    .showHelpAfterError()
    .action(() => program.help());
  addCommands(program, makers);
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
