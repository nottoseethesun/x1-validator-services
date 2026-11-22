/**
 * @file x1-validator-private-rpc/src/cli/program.js
 * @description
 * Builds the tool's command-line program with commander. What the tool
 * is for, its version, its commands and their options are declared here
 * once, and commander makes both the help text and the parsing from that
 * one declaration, so the two can't drift apart. Each on/off option
 * defaults to false, so a command always gets a boolean for it. A
 * command with a long description has a short summary too, for the list
 * of commands in the tool's own help.
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
import { oldestNode, oldestNodeText } from "../lib/node-version.js";
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
  "Makes an X1 validator's rpc private, puts it behind an https url that " +
  "carries an api key, and keeps it that way.";

/**
 * What the tool's own help says after its commands: where each command's
 * options are, the Node.js the tool needs, the launcher that gives it the
 * bare name the examples type, and the commonest runs.
 * @param {number} major  The Node.js major the tool runs on, from
 *   `engines` in package.json.
 * @param {string} oldest  The oldest Node.js the tool runs on, as the
 *   docs write it, such as "24".
 * @returns {string}
 */
function programExamples(major, oldest) {
  return `
Each command's --help gives its options and examples, such as
x1-validator-private-rpc apply --help.

The tool needs Node.js ${oldest} or newer, while a validator's default node
is Node.js 20.0.0, which x1console installed. The examples type the
tool's bare name, x1-validator-private-rpc. That works once you've linked
the tool's launcher, x1-validator-private-rpc/bin/x1-validator-private-rpc,
into ~/.local/bin, as the README's Run section shows. The launcher is a
script that runs the tool on the newest Node.js ${major} that nvm holds.
Without the link, run the tool from the project's folder,
~/x1-validator-services, as nvm exec ${major} node
x1-validator-private-rpc/src/cli.js.

Examples:
  x1-validator-private-rpc apply --acme-staging
      The first run, which sets the tool up, with a certificate from
      Let's Encrypt's staging service. apply's help says more.
  x1-validator-private-rpc add-api-key
      Makes an api key, such as for a new client, and prints its urls.
  x1-validator-private-rpc url
      Prints the url's two forms, https and wss, with KEY in place of the
      key, such as when you hold a key but not its urls.`;
}

/**
 * Each command's examples, as its help shows them, after its options and
 * before the exit codes: one for each common use.
 */
const EXAMPLES = {
  apply: `
Examples:
  x1-validator-private-rpc apply --dry-run
      Shows every change apply would make, and makes none.
  x1-validator-private-rpc apply --acme-staging
      The first run, with a certificate from Let's Encrypt's staging
      service. Let's Encrypt allows only five failed requests an hour for
      one hostname, and failures at the staging service don't count, so a
      mistake can't hold up the real certificate.
  x1-validator-private-rpc apply
      After the staging run, for the real certificate. Also after each
      update of the tool.`,
  ensure: `
Examples:
  x1-validator-private-rpc ensure
      Checks every part now, such as before you choose Update X1
      Validator, which restarts the validator: check that it says the
      start script carries --private-rpc. It puts the flag back if an
      update took it out. It also prints the two checks that send no
      alert: whether the running validator carries --private-rpc, and
      what listens on ports 80 and 443.
  x1-validator-private-rpc ensure --quiet
      As the cron job runs it: prints only what changed and the alerts
      sent.`,
  undoApply: `
Examples:
  x1-validator-private-rpc undo-apply --dry-run
      Shows every step undo-apply would take, and takes none.
  x1-validator-private-rpc undo-apply
      Uninstalls the tool: puts back what apply changed, newest change
      first. It leaves nginx installed, and says how to remove it.`,
  turnOff: `
Examples:
  x1-validator-private-rpc turn-off-private-rpc
      Makes the rpc public from the validator's next start, without
      uninstalling the tool.`,
  turnOn: `
Examples:
  x1-validator-private-rpc turn-on-private-rpc
      Makes the rpc private again from the validator's next start, after
      turn-off-private-rpc.`,
  addApiKey: `
Examples:
  x1-validator-private-rpc add-api-key
      Makes one api key, such as for a new client, and prints its https
      and wss urls. Save them: the client needs them, and you need the key
      to remove it later, since no command shows the key again.
  x1-validator-private-rpc add-api-key --count 3
      Makes three keys in one run, all with the one email you give, such
      as for one client's three apps. For three clients, run add-api-key
      once for each.`,
  removeApiKey: `
Examples:
  x1-validator-private-rpc remove-api-key
      Removes a key, such as one that leaked. It asks for the key, so the
      key never goes into your shell's history.`,
  url: `
Examples:
  x1-validator-private-rpc url
      Prints the url's two forms, https and wss, with KEY in place of the
      key, such as when you hold a key but not its urls.`,
  keyCount: `
Examples:
  x1-validator-private-rpc ensure-there-is-at-least-one-rpc-api-key
      Checks now that nginx's list holds a key.
  x1-validator-private-rpc ensure-there-is-at-least-one-rpc-api-key --quiet
      As its cron job runs it: prints only the alert, when there is one.`,
};

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
      "answer yes to each stage's question, and to whether to install the cron jobs, but still ask for the x1-validator-services password, which encrypts the keys' records, and whether to save it",
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
    .addHelpText("after", EXAMPLES.apply)
    .action(action(makers, "apply", runApply, SHOWS_DISCLAIMER.unlessDryRun));
  program
    .command("ensure")
    .summary(
      "keep --private-rpc in x1console's start script, check the rpc, " +
        "nginx and its certificate, and send alerts",
    )
    .description(
      "put --private-rpc back into x1console's start script after an " +
        "x1console update takes it out, check the rpc, nginx and its " +
        "certificate, and send alerts. The tool's git hook runs it when an " +
        "update's pull brings new commits. If you accept the cron job apply " +
        "offers, that job runs it every minute. Except from the git hook, " +
        "it leaves the start script alone while x1console may be updating, " +
        "so it never makes the update's git pull fail",
    )
    .option("-q, --quiet", "print only what changed and the alerts sent", false)
    .option(
      "--from-git-hook",
      "run as the tool's git hook, which puts the flag back at once, since git runs the hook once the update's merge is done",
      false,
    )
    .addHelpText("after", EXAMPLES.ensure)
    .action(action(makers, "ensure", runEnsure, SHOWS_DISCLAIMER.never));
  program
    .command("undo-apply")
    .description(
      "uninstall the tool: undo each change apply made when it set the " +
        "tool up, newest first, but leave nginx installed",
    )
    .option("--dry-run", "print every step, and change nothing", false)
    .addHelpText("after", EXAMPLES.undoApply)
    .action(
      action(makers, "undo-apply", runUndoApply, SHOWS_DISCLAIMER.unlessDryRun),
    );
  program
    .command("turn-off-private-rpc")
    .summary("make the rpc public from the validator's next start")
    .description(
      "make the rpc public from the validator's next start: take " +
        "--private-rpc out of the start script, and record the choice, so " +
        "that ensure, the command that puts the flag back after each " +
        "x1console update, leaves it out",
    )
    .option("-y, --yes", "skip the confirmation", false)
    .addHelpText("after", EXAMPLES.turnOff)
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
    .summary("make the rpc private again from the validator's next start")
    .description(
      "make the rpc private again from the validator's next start: put " +
        "--private-rpc back into the start script, and have ensure put it " +
        "back again after each x1console update",
    )
    .addHelpText("after", EXAMPLES.turnOn)
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
      "ask for the x1-validator-services password and an optional email, make api keys, and print each one's urls, once",
    )
    .option("--count <n>", "how many api keys to make", parseCount, 1)
    .addHelpText("after", EXAMPLES.addApiKey)
    .action(
      action(makers, "add-api-key", runAddApiKey, SHOWS_DISCLAIMER.always),
    );
  program
    .command("remove-api-key")
    .description("ask for an api key, and remove it so nginx refuses it")
    .addHelpText("after", EXAMPLES.removeApiKey)
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
    .addHelpText("after", EXAMPLES.url)
    .action(action(makers, "url", runUrl, SHOWS_DISCLAIMER.never));
  program
    .command("ensure-there-is-at-least-one-rpc-api-key")
    .summary(
      "send an alert while nginx's list holds no api key, since nginx then " +
        "refuses every request",
    )
    .description(
      "check that nginx's list of api keys' hashes isn't empty, since nginx " +
        "refuses every request while the list is empty, and send an alert " +
        "when it's empty. If you accept the cron jobs apply offers, one of " +
        "them runs it every few hours, as the apiKeyCountCheckHours setting " +
        "says",
    )
    .option("-q, --quiet", "print only the alert, when there is one", false)
    .addHelpText("after", EXAMPLES.keyCount)
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
 * tool is for, lists the commands and options, gives examples, and ends
 * with the exit codes. So does each command's help, with the command's
 * own options and examples. Asked for, the help goes to stdout with exit
 * code 0. Run with no
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
    .addHelpText("after", programExamples(oldestNode().major, oldestNodeText()))
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
