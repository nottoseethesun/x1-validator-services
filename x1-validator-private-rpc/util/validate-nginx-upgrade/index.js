#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
 * @description
 * The first step of installing x1-validator-private-rpc on a validator.
 * It proves, on this machine, that a regular apt upgrade of nginx keeps
 * the gated rpc working, so the install can go ahead with nginx left to
 * apt. steps.js does the work and describes it. terminal.js shows its
 * progress, with a spinner beside each long step, and its outcome, and
 * answers Ctrl-C by stopping the check after the step it's on, which
 * still removes everything it added. This entry point reads the command
 * line and the settings, and joins the two, once the person affirms the
 * disclaimer. Run it as the validator's account. It asks for sudo
 * itself.
 */

import { Command } from "commander";
import ora from "ora";
import { showDisclaimer } from "../../src/lib/disclaimer.js";
import { createHost } from "../../src/lib/host.js";
import { loadSettings } from "../../src/lib/settings.js";
import { validateNginxUpgrade } from "./steps.js";
import { createTerminal, reportOutcome } from "./terminal.js";

const PURPOSE = `Proves on this machine that a regular apt upgrade of nginx keeps
x1-validator-private-rpc's gated rpc working. It installs nginx.org's
previous release, runs it under systemd the way the tool will, upgrades
it with apt, and checks that systemd followed the new nginx and that the
new nginx still knows a throwaway api key's hash. Then it removes
everything it added.

Run it as the validator's account, before installing the tool. It asks
for sudo itself, and never touches the validator, port 443 or the
firewall. Ctrl-C stops it after the step it's on, and it still removes
everything it added.
`;

const EXIT_CODES = `
Exit codes:
  0  the upgrade kept the gated rpc working
  1  it didn't, the check couldn't run, or you declined the disclaimer.
     The reasons are printed`;

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
 * Shows the disclaimer, then runs the check and prints the outcome.
 */
async function main() {
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
