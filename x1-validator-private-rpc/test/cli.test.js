/**
 * @file x1-validator-private-rpc/test/cli.test.js
 * @description
 * Tests the tool's command-line program: its help, its version, and its
 * refusal of what it doesn't accept. Most tests parse argument lists
 * through a program built in the test, with commander's exits turned
 * into exceptions and its output caught. The last two run the real entry
 * point as a child process, the way a person runs it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildProgram, projectVersion } from "../src/cli/program.js";

/**
 * Builds the program with its exits turned into exceptions, and with
 * what it prints caught instead of written.
 * @returns {{program: import("commander").Command, out: () => string,
 *   err: () => string}} The program, and readers of its stdout and
 *   stderr text.
 */
function testProgram() {
  let out = "";
  let err = "";
  const program = buildProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        err += text;
      },
    });
  return { program, out: () => out, err: () => err };
}

/**
 * Runs the real entry point with the given arguments, and waits for it.
 * @param {string[]} args  The arguments.
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runCli(args) {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

test("help opens with what the tool is for and ends with the exit codes", () => {
  const { program, out } = testProgram();
  assert.throws(() => program.parse(["node", "cli", "--help"]), {
    code: "commander.helpDisplayed",
  });
  const help = out();
  assert.ok(help.startsWith("Puts an X1 validator's rpc behind an https url"));
  assert.match(help, /-h, --help +print this help and exit/);
  assert.match(help, /-v, --version +print the version and exit/);
  assert.ok(
    help.endsWith(
      "Exit codes:\n  0  success\n  1  an error; the reason is printed on stderr\n",
    ),
  );
});

test("the version option prints the project's version", () => {
  assert.match(projectVersion(), /^\d+\.\d+\.\d+/);
  const { program, out } = testProgram();
  assert.throws(() => program.parse(["node", "cli", "--version"]), {
    code: "commander.version",
  });
  assert.equal(out(), `${projectVersion()}\n`);
});

test("run with no command, the program prints its help", () => {
  const { program, out } = testProgram();
  assert.throws(() => program.parse(["node", "cli"]), {
    code: "commander.help",
  });
  assert.match(out(), /Usage: x1-validator-private-rpc/);
});

test("an unknown option is refused, with the reason on stderr", () => {
  const { program, err } = testProgram();
  assert.throws(() => program.parse(["node", "cli", "--bogus"]), {
    code: "commander.unknownOption",
    exitCode: 1,
  });
  assert.match(err(), /unknown option '--bogus'/);
});

test("an argument the program doesn't take is refused", () => {
  const { program } = testProgram();
  assert.throws(() => program.parse(["node", "cli", "extra"]), {
    code: "commander.excessArguments",
    exitCode: 1,
  });
});

test("the real entry point prints its help to stdout with exit code 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.startsWith("Puts an X1 validator's rpc"));
  assert.equal(result.stderr, "");
});

test("the real entry point refuses an unknown option with exit code 1", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option '--bogus'/);
  assert.equal(result.stdout, "");
});
