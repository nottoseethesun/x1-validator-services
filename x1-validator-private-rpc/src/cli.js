#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/src/cli.js
 * @description
 * The command-line entry point of x1-validator-private-rpc, and the only
 * file in the tool that runs anything as it loads. It hands the
 * process's arguments to the program that src/cli/program.js builds.
 */

import { runProgram } from "./cli/program.js";

await runProgram(process.argv);
