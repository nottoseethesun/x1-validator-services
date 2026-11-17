/**
 * @file x1-validator-private-rpc/src/cli/program.js
 * @description
 * Builds the tool's command-line program with commander. What the tool
 * is for, its version, its commands and their options are declared here
 * once, and commander makes both the help text and the parsing from that
 * one declaration, so the two can't drift apart. Each on/off option
 * defaults to false, so a command always gets a boolean for it.
 *
 * The program is built inside a function, never as the module loads, so
 * each test can build a fresh one and parse an argument list of its own.
 * What the commands work with, the host, the settings, the prompts and
 * the output, comes from a set of makers that the real run creates when
 * a command starts, and that tests replace with stand-ins.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { showDisclaimer } from "../lib/disclaimer.js";
import { createHost } from "../lib/host.js";
import { loadSettings, overrideFilePath } from "../lib/settings.js";
import { parseCount, runAddApiKey } from "./add-api-key.js";
import { runApply } from "./apply.js";
import { runEnsure } from "./ensure.js";
import { runEnsureApiKey } from "./ensure-there-is-at-least-one-rpc-api-key.js";
import { featurePaths } from "./feature-paths.js";
import { runUrl } from "./key-commands.js";
import { createLog } from "./log.js";
import { createPrompts } from "./prompts.js";
import { runRemoveApiKey } from "./remove-api-key.js";
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
  "  1  a stage failed, a check found a problem, you declined the",
  "     disclaimer, you answered no and the command stopped, or another",
  "     error, and the output says which",
].join("\n");

/**
 * Whether a command's run shows the disclaimer first: each run that can
 * change the system, when a person runs it. url, the key count check and
 * a dry run change nothing. ensure can, but cron and the tool's git hook
 * run it, with nobody at the terminal to answer.
 */
const SHOWS_DISCLAIMER = {
  always: () => true,
  never: () => false,
  unlessDryRun: (options) => options.dryRun === false,
};

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
 * @property {(host: object) => string} showDisclaimer  Shows the
 *   disclaimer, and gives "" once it's affirmed, or why the run can't go
 *   on.
 * @property {(yes: boolean) => import("./prompts.js").Prompts} prompts
 *   Makes the prompts.
 * @property {(line: string) => void} out  Prints a line on stdout.
 * @property {(line: string) => void} err  Prints a line on stderr.
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
    showDisclaimer: (host) => showDisclaimer(host),
    prompts: (yes) => createPrompts({ yes }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

/**
 * Makes a command's action. It shows the disclaimer first when the run
 * can change the system, gathers what the command works with, runs it,
 * and sets the exit code. A declined disclaimer stops the run before it
 * does anything, with exit code 1. An error prints its reason on stderr
 * and exits 1, without a stack trace.
 * @param {Makers} makers  The makers.
 * @param {string} name  The command.
 * @param {(run: object) => Promise<number>} work  The command's work.
 * @param {(options: object) => boolean} showsDisclaimer  Whether a run
 *   with these options shows the disclaimer first.
 * @returns {(options: object) => Promise<void>}
 */
function action(makers, name, work, showsDisclaimer) {
  return async (options) => {
    const log = makers.log();
    let code;
    try {
      const host = makers.host();
      const refusal = showsDisclaimer(options)
        ? makers.showDisclaimer(host)
        : "";
      if (refusal === "") {
        const settings = makers.settings();
        const overridePath = makers.overridePath();
        const paths = makers.paths();
        const prompts = makers.prompts(options.yes === true);
        code = await work({
          host,
          settings,
          overridePath,
          paths,
          log,
          prompts,
          out: makers.out,
          err: makers.err,
          options,
        });
      } else {
        log.info(name, `${refusal} Nothing changed.`);
        code = 1;
      }
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
    .option(
      "-y, --yes",
      "skip the confirmations, never a password or a choice",
      false,
    )
    .option(
      "--dry-run",
      "print every change apply would make, and make none",
      false,
    )
    .option(
      "--acme-staging",
      "get the certificate from Let's Encrypt's staging service, for a first run",
      false,
    )
    .action(action(makers, "apply", runApply, SHOWS_DISCLAIMER.unlessDryRun));
  program
    .command("ensure")
    .description(
      "put --private-rpc back after an update, check the setup and send alerts",
    )
    .option("-q, --quiet", "print only what changed and the alerts sent", false)
    .option(
      "--from-git-hook",
      "run as the tool's git hook, without waiting out an update",
      false,
    )
    .action(action(makers, "ensure", runEnsure, SHOWS_DISCLAIMER.never));
  program
    .command("undo-apply")
    .description("undo what apply did, newest step first")
    .option("--dry-run", "print every step, and change nothing", false)
    .action(
      action(makers, "undo-apply", runUndoApply, SHOWS_DISCLAIMER.unlessDryRun),
    );
  program
    .command("turn-off-private-rpc")
    .description(
      "take --private-rpc out of the start script, and keep ensure from putting it back",
    )
    .option("-y, --yes", "skip the confirmation", false)
    .action(
      action(
        makers,
        "turn-off-private-rpc",
        runTurnOffPrivateRpc,
        SHOWS_DISCLAIMER.always,
      ),
    );
  program
    .command("turn-on-private-rpc")
    .description(
      "put --private-rpc back into the start script, for ensure to keep there",
    )
    .action(
      action(
        makers,
        "turn-on-private-rpc",
        runTurnOnPrivateRpc,
        SHOWS_DISCLAIMER.always,
      ),
    );
  program
    .command("add-api-key")
    .description(
      "ask for the password and an optional email, make api keys, and print each one's urls, once",
    )
    .option("--count <n>", "how many api keys to make", parseCount, 1)
    .action(
      action(makers, "add-api-key", runAddApiKey, SHOWS_DISCLAIMER.always),
    );
  program
    .command("remove-api-key")
    .description("ask for an api key, and remove it so nginx refuses it")
    .action(
      action(
        makers,
        "remove-api-key",
        runRemoveApiKey,
        SHOWS_DISCLAIMER.always,
      ),
    );
  program
    .command("url")
    .description(
      "print the rpc's url forms, and how many api keys nginx's list holds",
    )
    .action(action(makers, "url", runUrl, SHOWS_DISCLAIMER.never));
  program
    .command("ensure-there-is-at-least-one-rpc-api-key")
    .description(
      "check that nginx's list holds an api key, and send an alert when it doesn't",
    )
    .option("-q, --quiet", "print only the alert, when there is one", false)
    .action(
      action(
        makers,
        "ensure-there-is-at-least-one-rpc-api-key",
        runEnsureApiKey,
        SHOWS_DISCLAIMER.never,
      ),
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
    .addHelpText("afterAll", EXIT_CODES)
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
