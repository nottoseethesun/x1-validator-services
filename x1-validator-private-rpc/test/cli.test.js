/**
 * @file x1-validator-private-rpc/test/cli.test.js
 * @description
 * Tests the tool's command-line program: its help, its version, its
 * refusal of what it doesn't accept, and its commands, each run with its
 * options on stand-ins, a failure exiting 1 with its reason, and the
 * disclaimer before each run that can change the system. Most tests
 * parse argument lists through a program built in the test, with
 * commander's exits turned into exceptions and its output caught. The
 * last two run the real entry point as a child process, the way a person
 * runs it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { featurePaths } from "../src/cli/feature-paths.js";
import { createLog } from "../src/cli/log.js";
import {
  buildProgram,
  EXIT_CODES,
  projectVersion,
} from "../src/cli/program.js";
import { DECLINED } from "../src/lib/disclaimer.js";
import { NGINX_UNIT } from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Builds the program with its exits, and its commands' exits, turned
 * into exceptions, and with what they print caught instead of written.
 * commander copies these settings to a command only when it's made, so
 * each command gets them here too.
 * @returns {{program: import("commander").Command, out: () => string,
 *   err: () => string}} The program, and readers of its stdout and
 *   stderr text.
 */
function testProgram() {
  let out = "";
  let err = "";
  const program = buildProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        err += text;
      },
    });
  }
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
  assert.ok(help.endsWith(`${EXIT_CODES}\n`), help);
  for (const command of [
    "apply",
    "ensure",
    "undo-apply",
    "turn-off-private-rpc",
    "turn-on-private-rpc",
    "add-api-key",
    "remove-api-key",
    "url",
    "ensure-there-is-at-least-one-rpc-api-key",
  ]) {
    assert.match(help, new RegExp(`^  ${command}\\b`, "m"), command);
  }
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

/**
 * Makes stand-in makers on a fake validator, and keeps what the commands
 * print, the exit code they set and how often the disclaimer showed.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {string} [refusal]  What the disclaimer gives: "" for an
 *   affirmed one, unless the test passes a refusal.
 * @returns {{makers: object, out: string[], err: string[],
 *   code: () => number, shown: () => number}}
 */
function standInMakers(host, settings, refusal = "") {
  const out = [];
  const err = [];
  let code = null;
  let shown = 0;
  const makers = {
    host: () => host,
    settings: () => settings,
    overridePath: () => "/operator/private-rpc.json",
    paths: () => featurePaths(),
    log: () =>
      createLog({
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }),
    showDisclaimer: (shownOn) => {
      assert.equal(shownOn, host);
      shown += 1;
      return refusal;
    },
    prompts: () => scriptedPrompts(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    setExitCode: (exitCode) => {
      code = exitCode;
    },
  };
  return { makers, out, err, code: () => code, shown: () => shown };
}

test("each run that can change the system shows the disclaimer first, and a refusal stops it with nothing done", async () => {
  const settings = loadSettings(
    copyShippedConfig('{"hostname": "x1-rpc.example.com"}').configDir,
  );
  const cases = [
    [["apply"], true],
    [["apply", "--dry-run"], false],
    [["undo-apply"], true],
    [["undo-apply", "--dry-run"], false],
    [["turn-off-private-rpc"], true],
    [["turn-on-private-rpc"], true],
    [["add-api-key"], true],
    [["remove-api-key"], true],
    [["url"], false],
    [["ensure"], false],
    [["ensure-there-is-at-least-one-rpc-api-key"], false],
  ];
  for (const [args, shows] of cases) {
    const { host } = fakeX1Validator();
    const callsBefore = host.calls.length;
    const run = standInMakers(host, settings, DECLINED);
    await buildProgram(run.makers).parseAsync(["node", "cli", ...args]);
    assert.equal(run.shown(), shows === true ? 1 : 0, args.join(" "));
    if (shows === true) {
      assert.equal(run.code(), 1, args.join(" "));
      assert.deepEqual(run.out, [`[${args[0]}] ${DECLINED} Nothing changed.`]);
      assert.equal(host.calls.length, callsBefore, args.join(" "));
    }
  }
});

test("each command runs with its options, and a failure exits 1 with its reason", async () => {
  const settings = loadSettings(
    copyShippedConfig('{"hostname": "x1-rpc.example.com"}').configDir,
  );
  const { host } = fakeX1Validator();
  const dry = standInMakers(host, settings);
  await buildProgram(dry.makers).parseAsync([
    "node",
    "cli",
    "apply",
    "--dry-run",
  ]);
  assert.equal(dry.code(), 0, dry.err.join("\n"));
  assert.ok(dry.out.some((line) => line.includes(`Would mask ${NGINX_UNIT}`)));
  const url = standInMakers(host, settings);
  await buildProgram(url.makers).parseAsync(["node", "cli", "url"]);
  assert.equal(url.code(), 1);
  assert.deepEqual(url.err, [
    "[url] apply hasn't set nginx up yet. Run apply first.",
  ]);
  const add = standInMakers(host, settings);
  const adding = buildProgram(add.makers);
  await adding.parseAsync(["node", "cli", "add-api-key", "--count", "2"]);
  const addCommand = adding.commands.find(
    (each) => each.name() === "add-api-key",
  );
  assert.deepEqual(addCommand.opts(), { count: 2 });
  assert.deepEqual(add.err, [
    "[add-api-key] apply hasn't set nginx up yet. Run apply first.",
  ]);
  for (const args of [
    ["ensure", "--quiet"],
    ["ensure-there-is-at-least-one-rpc-api-key", "--quiet"],
    ["undo-apply", "--dry-run"],
  ]) {
    const run = standInMakers(host, settings);
    await buildProgram(run.makers).parseAsync(["node", "cli", ...args]);
    assert.equal(run.code(), 0, args.join(" "));
  }
});

test("each on/off option reaches its command as a boolean, false when left out", async () => {
  const settings = loadSettings(
    copyShippedConfig('{"hostname": "x1-rpc.example.com"}').configDir,
  );
  const { host } = fakeX1Validator();
  const cases = [
    [["apply", "--dry-run"], { yes: false, dryRun: true, acmeStaging: false }],
    [["ensure", "--quiet"], { quiet: true, fromGitHook: false }],
    [["ensure-there-is-at-least-one-rpc-api-key"], { quiet: false }],
    [["undo-apply"], { dryRun: false }],
    [["turn-off-private-rpc"], { yes: false }],
    [["add-api-key"], { count: 1 }],
  ];
  for (const [args, options] of cases) {
    const program = buildProgram(standInMakers(host, settings).makers);
    await program.parseAsync(["node", "cli", ...args]);
    const command = program.commands.find((each) => each.name() === args[0]);
    assert.deepEqual(command.opts(), options, args.join(" "));
  }
});

test("add-api-key refuses a bad --count before the disclaimer, naming the option", async () => {
  const settings = loadSettings(
    copyShippedConfig('{"hostname": "x1-rpc.example.com"}').configDir,
  );
  const cases = [
    ["--count", "0"],
    ["--count", "1.5"],
    ["--count", "two"],
  ];
  for (const [option, value] of cases) {
    const { host } = fakeX1Validator();
    const run = standInMakers(host, settings);
    const program = buildProgram(run.makers);
    let err = "";
    for (const command of [program, ...program.commands]) {
      command.exitOverride().configureOutput({
        writeErr: (text) => {
          err += text;
        },
      });
    }
    const args = ["node", "cli", "add-api-key", option, value];
    await assert.rejects(program.parseAsync(args), {
      code: "commander.invalidArgument",
      exitCode: 1,
    });
    const flags = program.commands
      .find((each) => each.name() === "add-api-key")
      .options.find((each) => each.long === option).flags;
    assert.ok(
      err.includes(`option '${flags}' argument '${value}' is invalid.`),
      err,
    );
    assert.equal(run.shown(), 0, `${option} ${value}`);
  }
});
