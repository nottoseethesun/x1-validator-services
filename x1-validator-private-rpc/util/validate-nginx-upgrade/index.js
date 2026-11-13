#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
 * @description
 * The first step of installing x1-validator-private-rpc on a validator.
 * It proves, on this machine, that a regular apt upgrade of nginx keeps
 * the gated rpc working, so the install can go ahead with nginx left to
 * apt. steps.js does the work and describes it; this entry point reads
 * the command line and the settings, and prints the outcome. On a
 * terminal, a spinner shows that a long step is still at work. Ctrl-C
 * stops the check after the step it's on, and the check still removes
 * everything it added. Run it as the validator's account; it asks for
 * sudo itself.
 */

import { Command } from "commander";
import ora from "ora";
import { createHost } from "../../src/lib/host.js";
import { loadSettings } from "../../src/lib/settings.js";
import { validateNginxUpgrade } from "./steps.js";

const PREFIX = "[validate-nginx-upgrade]";

const PURPOSE = `Proves on this machine that a regular apt upgrade of nginx keeps
x1-validator-private-rpc's gated rpc working. It installs nginx.org's
previous release, runs it under systemd the way the tool will, upgrades
it with apt, and checks that systemd followed the new nginx and that the
api key carried over. Then it removes everything it added.

Run it as the validator's account, before installing the tool. It asks
for sudo itself, and never touches the validator, port 443 or the
firewall. Ctrl-C stops it after the step it's on, and it still removes
everything it added.
`;

const EXIT_CODES = `
Exit codes:
  0  the upgrade kept the gated rpc working
  1  it didn't, or the check couldn't run; the reasons are printed`;

/**
 * Builds the command-line program, which takes no options besides help.
 * @returns {Command}
 */
function buildProgram() {
  return new Command("validate-nginx-upgrade")
    .helpOption("-h, --help", "print this help and exit")
    .addHelpText("beforeAll", PURPOSE)
    .addHelpText("after", EXIT_CODES)
    .showHelpAfterError();
}

/**
 * Builds how the check talks to the person at the terminal: its progress
 * lines, a spinner beside each long step, and its answer to Ctrl-C.
 *
 * While the spinner turns, ora reads the keyboard itself, so a Ctrl-C
 * reaches only this program, and apt's work underneath finishes. At other
 * times a Ctrl-C also stops the command running, and that step fails.
 * Either way the check stops at its next step and removes what it added.
 * @returns {{report: Function, wait: Function, isInterrupted: Function}}
 */
function createTerminal() {
  let spinner = null;
  let interrupted = false;
  const report = (line) => {
    spinner?.clear();
    console.log(`${PREFIX} ${line}`);
    spinner?.render();
  };
  process.on("SIGINT", () => {
    if (!interrupted) {
      interrupted = true;
      report(
        "Ctrl-C: stopping after this step, then removing everything the " +
          "check added.",
      );
    }
  });
  // ora needs a terminal that reports its width; it never stops otherwise.
  const canSpin = process.stdout.isTTY === true && process.stdout.columns > 0;
  const wait = async (line, work) => {
    if (!canSpin) {
      report(line);
      return work();
    }
    spinner = ora({ text: `${PREFIX} ${line}`, stream: process.stdout });
    spinner.start();
    try {
      return await work();
    } finally {
      spinner.stopAndPersist({ symbol: "" });
      spinner = null;
    }
  };
  return { report, wait, isInterrupted: () => interrupted };
}

/**
 * Runs the check and prints the outcome.
 */
async function main() {
  buildProgram().parse(process.argv);
  const terminal = createTerminal();
  let result;
  try {
    result = await validateNginxUpgrade({
      host: createHost(),
      settings: loadSettings(),
      ...terminal,
    });
  } catch (error) {
    result = { passed: false, problems: [error.message], leftovers: [] };
  }
  if (result.passed) {
    terminal.report(
      "Passed: an apt upgrade of nginx keeps the gated rpc unlocked.",
    );
    return;
  }
  for (const problem of [...result.problems, ...result.leftovers]) {
    console.error(`${PREFIX} ${problem}`);
  }
  console.error(
    result.leftovers.length === 0
      ? `${PREFIX} Failed. The check removed everything it added.`
      : `${PREFIX} Failed, and some of what the check added is still in ` +
          "place, as listed above.",
  );
  process.exitCode = 1;
}

await main();
