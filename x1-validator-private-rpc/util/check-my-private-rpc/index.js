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
 * point checks the Node.js running it, reads the command line, the
 * settings and the two answers, and joins them. It never prints the key,
 * only its last four characters.
 */

import { Command } from "commander";
import { askLine } from "../../src/lib/ask-line.js";
import { askPassword } from "../../src/lib/ask-password.js";
import { createHost } from "../../src/lib/host.js";
import { maskSecret } from "../../src/lib/mask-secret.js";
import {
  nodeHelpNote,
  nodeVersionProblem,
  oldestNode,
  oldestNodeText,
} from "../../src/lib/node-version.js";
import { loadSettings } from "../../src/lib/settings.js";
import { checkingLine, inputProblem, judge, sendQueries } from "./check.js";
import { renderReport, renderVerdict } from "./table.js";

/** How the check starts from the project's folder, before nvm's part. */
const COMMAND =
  "node x1-validator-private-rpc/util/check-my-private-rpc/index.js";

const PURPOSE = `Checks once that a private rpc's keyed url, the https url with an api
key in its path, works for a client, from any machine with the project
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
 * The examples, as the help shows them, before the exit codes.
 * @param {string} start  The command that starts the check on the
 *   Node.js the project needs.
 * @returns {string}
 */
function examples(start) {
  return `
Examples:
  cd ~/x1-validator-services
  ${start}
      Checks the keyed url, such as after apply, or when a client reports
      a problem. The url that the tool's apply or add-api-key command
      printed holds both answers: the hostname, and after it the key.`;
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
    .addHelpText(
      "beforeAll",
      `${PURPOSE}\n${nodeHelpNote()} On a machine without nvm, start it with a node of version\n` +
        `${oldestNodeText()} or newer.\n`,
    )
    .addHelpText("after", `${examples(start)}\n${EXIT_CODES}`)
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
 * Checks the Node.js running it, then runs the check, and sets the exit
 * code from its outcome.
 */
async function main() {
  const problem = nodeVersionProblem(process.versions.node, {
    name: "check-my-private-rpc",
    command: COMMAND,
    note: "",
  });
  if (problem !== "") {
    console.error(problem);
    process.exitCode = 1;
    return;
  }
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
