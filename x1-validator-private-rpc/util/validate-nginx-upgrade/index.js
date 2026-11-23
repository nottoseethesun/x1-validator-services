#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
 * @description
 * The first step of installing x1-validator-private-rpc on a validator.
 * It proves, on this machine, that a regular apt upgrade of nginx keeps
 * the keyed url working, so the install can go ahead with nginx left to
 * apt. steps.js does the work and describes it. terminal.js shows its
 * progress, with a spinner beside each long step, and its outcome, and
 * answers Ctrl-C by stopping the check after the step it's on, which
 * still removes everything it added. This entry point checks the Node.js
 * running it, reads the command line and the settings, and joins the
 * two, once the person affirms the disclaimer. Run it as the validator's
 * account. It asks for sudo itself.
 */

import { Command } from "commander";
import ora from "ora";
import { showDisclaimer } from "../../src/lib/disclaimer.js";
import { createHost } from "../../src/lib/host.js";
import {
  nodeHelpNote,
  nodeVersionProblem,
  oldestNode,
} from "../../src/lib/node-version.js";
import { loadSettings } from "../../src/lib/settings.js";
import { validateNginxUpgrade } from "./steps.js";
import { createTerminal, reportOutcome } from "./terminal.js";

/** How the check starts from the project's folder, before nvm's part. */
const COMMAND =
  "node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js";

const PURPOSE = `Once x1-validator-private-rpc is installed, nginx updates with the
system's other packages. This check proves on this machine that such an
apt upgrade keeps the tool's keyed url, the https url with an api key in
its path, working. It installs nginx.org's previous release, runs it
under systemd the way the tool will, with a throwaway api key, and
upgrades it with apt. nginx.org's upgrade starts a new nginx process and
hands over to it, without a restart, and the old process then exits.
systemd knows nginx by its main process, so systemd must follow that
handover. If systemd didn't, it would stop nginx, the new process
included, or restart nginx, which drops every open connection. The check
makes sure it did: systemd still counts nginx as running, now as the new
process, with no restart. It also makes sure the new nginx still lets
the throwaway key through and turns a random one away. Then it removes
everything it added.

Run it as the validator's account, before installing the tool. It asks
for sudo itself, and never touches the validator, port 443 or the
firewall. Ctrl-C stops it after the step it's on, and it still removes
everything it added.
`;

const EXIT_CODES = `
Exit codes:
  0  an upgrade keeps the keyed url working
  1  it didn't, the check couldn't run, or you declined the disclaimer.
     The reasons are printed`;

/**
 * The examples, as the help shows them, before the exit codes.
 * @param {string} start  The command that starts the check on the
 *   Node.js the project needs.
 * @returns {string}
 */
function examples(start) {
  return `
Examples:
  tmux
  cd ~/x1-validator-services
  ${start}
      The first step of installing the tool, run from the project's
      folder. It takes a few minutes. Inside tmux, a dropped ssh
      connection can't stop it halfway, and tmux attach gets you back to
      it.`;
}

/**
 * Builds the command-line program, which takes no options besides help.
 * Its usage line and example start the check through nvm, on the Node.js
 * major that `engines` in package.json names.
 * @returns {Command}
 */
function buildProgram() {
  const start = `nvm exec ${oldestNode().major} ${COMMAND}`;
  return new Command(start)
    .helpOption("-h, --help", "print this help and exit")
    .addHelpText("beforeAll", `${PURPOSE}\n${nodeHelpNote()}\n`)
    .addHelpText("after", `${examples(start)}\n${EXIT_CODES}`)
    .showHelpAfterError();
}

/**
 * Checks the Node.js running it, shows the disclaimer, then runs the
 * check and prints the outcome.
 */
async function main() {
  const problem = nodeVersionProblem(process.versions.node, {
    name: "validate-nginx-upgrade",
    command: COMMAND,
    note: "",
  });
  if (problem !== "") {
    console.error(problem);
    process.exitCode = 1;
    return;
  }
  buildProgram().parse(process.argv);
  const host = createHost();
  const refusal = showDisclaimer(host);
  if (refusal !== "") {
    console.log(`${refusal} Nothing changed.`);
    process.exitCode = 1;
    return;
  }
  const terminal = createTerminal({
    stdout: process.stdout,
    signals: process,
    makeSpinner: ora,
  });
  let result;
  try {
    const settings = loadSettings();
    result = await validateNginxUpgrade({ host, settings, ...terminal });
  } catch (error) {
    result = { passed: false, problems: [error.message], leftovers: [] };
  }
  process.exitCode = reportOutcome(result, terminal.report);
}

await main();
