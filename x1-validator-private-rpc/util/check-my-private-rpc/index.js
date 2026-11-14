#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/util/check-my-private-rpc/index.js
 * @description
 * A one-off check of a private rpc's keyed url. It asks for the rpc's
 * hostname and the api key, which it doesn't show as it's typed. Then it
 * sends the rpc a run of queries through nginx, one right after another,
 * and prints a table of the answers. It ends with a green check mark when
 * every query worked, or a red cross and what went wrong. check.js sends
 * and judges the queries, and table.js draws the report. This entry
 * point reads the command line, the settings and the two answers, and
 * joins them. It never prints the key, only its last four characters.
 */

import { Command } from "commander";
import { askLine } from "../../src/lib/ask-line.js";
import { askPassword } from "../../src/lib/ask-password.js";
import { createHost } from "../../src/lib/host.js";
import { maskSecret } from "../../src/lib/mask-secret.js";
import { loadSettings } from "../../src/lib/settings.js";
import { checkingLine, inputProblem, judge, sendQueries } from "./check.js";
import { renderReport, renderVerdict } from "./table.js";

const PURPOSE = `Checks a private rpc's keyed url once, from any machine with the project
installed. It asks for the rpc's hostname and the api key, sends the rpc
a run of queries through nginx, one right after another, and prints a
table of the answers. A green check mark at the end means every query
worked. A red cross comes with what went wrong.
`;

const EXIT_CODES = `
Exit codes:
  0  every query worked
  1  a query failed, or an answer wasn't a hostname or an api key. The
     reason is printed`;

/**
 * Builds the command-line program, which takes no options besides help.
 * @returns {Command}
 */
function buildProgram() {
  return new Command("check-my-private-rpc")
    .helpOption("-h, --help", "print this help and exit")
    .addHelpText("beforeAll", PURPOSE)
    .addHelpText("after", EXIT_CODES)
    .showHelpAfterError();
}

/**
 * Asks for the two answers, runs the check and prints the report.
 * @param {boolean} color  Whether the output is a terminal.
 * @returns {Promise<boolean>} Whether every query worked.
 */
async function check(color) {
  const settings = loadSettings();
  const hostname = (
    await askLine("The rpc's hostname, such as x1-rpc.example.com: ")
  ).trim();
  const key = (await askPassword("The api key: ")).trim();
  const problem = inputProblem(hostname, key);
  if (problem !== "") {
    console.log(renderVerdict(false, problem, color));
    return false;
  }
  console.log(`${checkingLine(settings, hostname, key)}\n`);
  const host = createHost();
  const results = await sendQueries(host, settings, { hostname, key });
  const judged = judge(results, hostname);
  for (const line of renderReport(results, judged, color)) {
    console.log(line.replaceAll(key, maskSecret(key)));
  }
  return judged.passed;
}

/**
 * Runs the check, and sets the exit code from its outcome.
 */
async function main() {
  buildProgram().parse(process.argv);
  const color = process.stdout.isTTY === true;
  try {
    process.exitCode = (await check(color)) === true ? 0 : 1;
  } catch (error) {
    console.log(renderVerdict(false, error.message, color));
    process.exitCode = 1;
  }
}

await main();
