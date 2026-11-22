#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/src/cli.js
 * @description
 * The command-line entry point of x1-validator-private-rpc, and the only
 * file in the tool that runs anything as it loads. It checks that the
 * Node.js running it is one the project supports, then hands the
 * process's arguments to the program that src/cli/program.js builds.
 */

import { runProgram } from "./cli/program.js";
import { nodeVersionProblem, oldestNode } from "./lib/node-version.js";

const problem = nodeVersionProblem(process.versions.node, {
  name: "x1-validator-private-rpc",
  command: "node x1-validator-private-rpc/src/cli.js COMMAND",
  note:
    "To type the tool's name instead, link its launcher, " +
    "x1-validator-private-rpc/bin/x1-validator-private-rpc, into " +
    "~/.local/bin, as the README's Usage section shows. The launcher is a " +
    `script that runs the tool on Node.js ${oldestNode().major}.`,
});
if (problem === "") {
  await runProgram(process.argv);
} else {
  console.error(problem);
  process.exitCode = 1;
}
