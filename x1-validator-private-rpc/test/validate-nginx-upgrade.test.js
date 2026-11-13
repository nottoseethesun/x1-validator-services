/**
 * @file x1-validator-private-rpc/test/validate-nginx-upgrade.test.js
 * @description
 * Tests the nginx upgrade check on a fake host that plays a validator:
 * the order of its steps, its verdict in each way the upgrade can go,
 * and its clean-up, which must remove everything it added even when a
 * step fails. It also tests the check's decisions and test configuration
 * on their own, and runs the real entry point for its help.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
} from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  machineProblems,
  upgradeProblems,
} from "../util/validate-nginx-upgrade/judge.js";
import { renderTestNginxConfig } from "../util/validate-nginx-upgrade/render-test-config.js";
import { validateNginxUpgrade } from "../util/validate-nginx-upgrade/steps.js";
import { createFakeHost } from "./helpers/fake-host.js";

const NJS_SOURCE = fileURLToPath(
  new URL("../src/njs/x1-validator-private-rpc.js", import.meta.url),
);

const NGINX_ORG =
  "https://nginx.org/packages/ubuntu noble/nginx amd64 Packages";

const POLICY = [
  ["nginx", "1.30.6-1~noble", "1.30.5-1~noble"],
  ["nginx-module-njs", "1.30.6+1.0.2-1~noble", "1.30.5+1.0.1-1~noble"],
  ["nginx-module-acme", "1.30.6+0.4.2-1~noble", "1.30.5+0.4.1-1~noble"],
]
  .flatMap(([name, ...versions]) => [
    `${name}:`,
    "  Installed: (none)",
    `  Candidate: ${versions[0]}`,
    "  Version table:",
    ...versions.flatMap((version) => [
      `     ${version} 900`,
      `        900 ${NGINX_ORG}`,
    ]),
  ])
  .join("\n");

/** Text in the command line of the step that removes the packages. */
const PURGE = "purge --yes nginx";

const COLONS = [
  "pub:-:2048:1:A:1:::-:::scESC::::::23::0:",
  "fpr:::::::::573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62:",
  "pub:-:4096:1:B:1:::-:::scSC::::::23::0:",
  "fpr:::::::::8540A6F18833A80E9C1653A42FD21310B49F6B46:",
].join("\n");

/**
 * Answers the commands about nginx's user, which nginx's package creates.
 * @param {string} line  The command line.
 * @param {object} state  The fake validator's state.
 * @returns {object|undefined}
 */
function userAnswer(line, state) {
  if (line === "getent passwd nginx") {
    return state.nginxUser
      ? { stdout: "nginx:x:101:101::/nonexistent" }
      : { status: 2 };
  }
  if (line === "userdel nginx") {
    state.nginxUser = false;
    return {};
  }
  return undefined;
}

/**
 * Plays an apt install: the first one installs nginx and creates its
 * user; a later one upgrades nginx, handing over to a new main process.
 * @param {object} call  The command.
 * @param {object} state  The fake validator's state.
 * @param {Map<string, string>} files  The fake's files.
 */
function playInstall(call, state, files) {
  if (state.installed !== null) {
    if (!state.keepOldMain) {
      files.delete(`/proc/${state.mainPid}`);
    }
    state.mainPid = state.upgradedPid;
    state.active = state.activeAfter;
  }
  state.installed = call.args.find((arg) => arg.startsWith("nginx=")).slice(6);
  state.nginxUser = true;
}

/**
 * Answers the commands every scenario shares, from the scenario's state.
 * @param {object} call  The command.
 * @param {object} state  The fake validator's state, changed by installs.
 * @param {Map<string, string>} files  The fake's files.
 * @returns {object|undefined}
 */
function commonAnswer(call, state, files) {
  const line = [call.command, ...call.args].join(" ");
  if (line === "systemctl --version") {
    return { stdout: "systemd 255 (255.4-1ubuntu8)\n" };
  }
  if (call.command === "dpkg-query") {
    return state.installed === null
      ? { status: 1 }
      : { stdout: `install ok installed ${state.installed}` };
  }
  if (call.command === "gpg" && call.args.includes("--show-keys")) {
    return { stdout: COLONS };
  }
  if (call.command === "apt" && call.args.includes("policy")) {
    return { stdout: POLICY };
  }
  if (call.args.includes("apt") && call.args.includes("install")) {
    playInstall(call, state, files);
    return undefined;
  }
  const userAnswered = userAnswer(line, state);
  if (userAnswered !== undefined) {
    return userAnswered;
  }
  if (line.startsWith("systemctl show")) {
    return {
      stdout:
        `ActiveState=${state.active}\nInvocationID=${state.invocation}\n` +
        `MainPID=${state.mainPid}\n`,
    };
  }
  if (call.kind === "sudo" && call.command === "readlink") {
    return { stdout: "/usr/sbin/nginx\n" };
  }
  return undefined;
}

/**
 * Builds a fake validator for one scenario.
 * @param {object} [overrides]  How this scenario differs.
 * @param {(call: object, state: object) => object|undefined}
 *   [overrides.respond]  Answers some commands before the common ones.
 * @param {object} [overrides.state]  Changes to the starting state.
 * @param {(url: string) => Promise<object>} [overrides.httpGet]  Answers
 *   the gate page.
 * @returns {{host: object, state: object}}
 */
function fakeValidator(overrides = {}) {
  const state = {
    installed: null,
    mainPid: "100",
    upgradedPid: "200",
    invocation: "invocation-1",
    active: "active",
    activeAfter: "active",
    keepOldMain: false,
    nginxUser: false,
    ...overrides.state,
  };
  const files = new Map([
    ["/etc/os-release", "ID=ubuntu\nVERSION_CODENAME=noble\n"],
    [NJS_SOURCE, "export default {};\n"],
    ["/proc/100", ""],
    ["/etc/nginx", ""],
    ["/etc/systemd/system", ""],
  ]);
  const respond = (call) =>
    overrides.respond?.(call, state) ?? commonAnswer(call, state, files);
  const host = createFakeHost({
    respond,
    files,
    httpsGet: async () => ({ status: 200, body: "-----BEGIN PGP-----" }),
    httpGet: overrides.httpGet,
  });
  return { host, state };
}

/**
 * Runs the check on a fake validator.
 * @param {object} host  The fake host.
 * @param {object} [options]  More of validateNginxUpgrade's options, such
 *   as `wait` or `isInterrupted`.
 * @returns {Promise<{result: object, lines: string[]}>}
 */
async function runCheck(host, options = {}) {
  const lines = [];
  const result = await validateNginxUpgrade({
    host,
    settings: loadSettings(),
    report: (line) => lines.push(line),
    ...options,
  });
  return { result, lines };
}

/**
 * Finds the position of the first call matching a description.
 * @param {object[]} calls  The fake's calls.
 * @param {string} text  Text the call's command line contains, or the
 *   path a file call names.
 * @returns {number} Its index, or -1.
 */
function indexOfCall(calls, text) {
  return calls.findIndex((call) =>
    call.command === undefined
      ? `${call.kind} ${call.path}`.includes(text)
      : [call.kind, call.command, ...call.args].join(" ").includes(text),
  );
}

test("passes when the upgrade keeps nginx running and unlocked", async () => {
  const { host } = fakeValidator();
  const { result } = await runCheck(host);
  assert.deepEqual(result, { passed: true, problems: [], leftovers: [] });
});

test("masks nginx before installing, and upgrades only after the start", async () => {
  const { host } = fakeValidator();
  await runCheck(host);
  const order = [
    "sudo systemctl mask nginx.service",
    "nginx=1.30.5-1~noble",
    "sudo systemctl start nginx.service",
    "nginx=1.30.6-1~noble",
  ].map((text) => indexOfCall(host.calls, text));
  assert.ok(
    order.every((index) => index >= 0),
    String(order),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

test("hands over a well-formed test key in a file only root can read", async () => {
  const { host } = fakeValidator();
  const settings = loadSettings();
  const written = [];
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, content, mode) => {
    written.push({ filePath, content, mode });
    writeRootFile(filePath, content, mode);
  };
  await runCheck(host);
  const keyFile = written.find(
    (file) => file.filePath === settings.keyHandOffPath,
  );
  assert.equal(keyFile.mode, "0600");
  assert.match(keyFile.content, /^[0-9a-f]{64}$/);
  const config = written.find(
    (file) => file.filePath === settings.nginxConfigPath,
  );
  assert.match(config.content, /listen 127\.0\.0\.1:18080;/);
});

test("removes everything it added, newest first", async () => {
  const { host } = fakeValidator();
  const settings = loadSettings();
  await runCheck(host);
  const order = [
    "sudo systemctl stop nginx.service",
    `removeRootFile ${settings.systemdDropInPath}`,
    PURGE,
    "sudo systemctl unmask nginx.service",
    `removeRootFile ${NGINX_APT_SOURCE_PATH}`,
    "sudo userdel nginx",
  ].map((text) =>
    host.calls.findLastIndex((call) =>
      call.command === undefined
        ? `${call.kind} ${call.path}` === text
        : [call.kind, call.command, ...call.args].join(" ").includes(text),
    ),
  );
  assert.ok(
    order.every((index) => index >= 0),
    String(order),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  for (const filePath of [
    settings.njsModulePath,
    settings.nginxConfigPath,
    settings.startWrapperPath,
    settings.systemdDropInPath,
    settings.keyHandOffPath,
    NGINX_APT_PIN_PATH,
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("refuses to run where nginx is already installed, changing nothing", async () => {
  const { host } = fakeValidator({ state: { installed: "1.30.6-1~noble" } });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.match(
    result.problems[0],
    /nginx 1\.30\.6-1~noble is already installed/,
  );
  assert.equal(host.calls.filter((call) => call.kind !== "run").length, 0);
});

test("fails when systemd loses track of nginx in the upgrade", async () => {
  const { host } = fakeValidator({
    state: { upgradedPid: "0", activeAfter: "inactive" },
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.ok(result.problems.some((problem) => /lost track/.test(problem)));
  assert.ok(indexOfCall(host.calls, PURGE) >= 0);
});

test("fails when systemd restarts nginx instead of following it", async () => {
  const { host } = fakeValidator({
    respond: (call, state) => {
      if (call.args?.[0] === "show" && state.installed === "1.30.6-1~noble") {
        state.invocation = "invocation-2";
      }
      return undefined;
    },
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.ok(result.problems.some((problem) => /restarted nginx/.test(problem)));
});

test("cleans up when a step fails part way", async () => {
  const { host } = fakeValidator({
    respond: (call) =>
      call.args?.includes("nginx=1.30.5-1~noble")
        ? { status: 100, stderr: "E: Unable to fetch some archives" }
        : undefined,
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.match(
    result.problems[0],
    /Installing nginx=1\.30\.5-1~noble.* failed with exit code 100: E: Unable to fetch/,
  );
  assert.equal(indexOfCall(host.calls, "systemctl start"), -1);
  for (const text of [PURGE, "systemctl unmask"]) {
    assert.ok(indexOfCall(host.calls, text) >= 0, text);
  }
  assert.equal(
    indexOfCall(host.calls, "sudo userdel nginx"),
    -1,
    "nginx's package never created its user",
  );
  assert.deepEqual(result.leftovers, []);
});

test("a failed apt update removes the repository files, with no false leftovers", async () => {
  const { host } = fakeValidator({
    respond: (call) =>
      call.command === "apt" && call.args.includes("update")
        ? {
            status: 100,
            stderr: "E: Could not get lock /var/lib/apt/lists/lock",
          }
        : undefined,
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.match(
    result.problems[0],
    /^Refreshing apt's package lists failed with exit code 100: E: Could not get lock/,
  );
  assert.deepEqual(result.leftovers, []);
  for (const filePath of [
    NGINX_KEYRING_PATH,
    NGINX_APT_SOURCE_PATH,
    NGINX_APT_PIN_PATH,
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("Ctrl-C stops the check after the step it's on, and everything is still removed", async () => {
  let pressed = false;
  const { host } = fakeValidator({
    respond: (call) => {
      if (call.args?.includes("nginx=1.30.5-1~noble")) {
        pressed = true;
      }
      return undefined;
    },
  });
  const { result } = await runCheck(host, { isInterrupted: () => pressed });
  assert.deepEqual(result, {
    passed: false,
    problems: ["Stopped because Ctrl-C was pressed."],
    leftovers: [],
  });
  assert.equal(indexOfCall(host.calls, "systemctl start"), -1);
  assert.equal(indexOfCall(host.calls, "nginx=1.30.6-1~noble"), -1);
  for (const text of [PURGE, "systemctl unmask", "sudo userdel nginx"]) {
    assert.ok(indexOfCall(host.calls, text) >= 0, text);
  }
});

test("the long steps run through the spinner, saying the installs take minutes", async () => {
  const { host } = fakeValidator();
  const waited = [];
  await runCheck(host, {
    wait: async (line, work) => {
      waited.push(line);
      return work();
    },
  });
  assert.deepEqual(waited, [
    "Adding nginx.org's apt repository.",
    "Installing nginx 1.30.5-1~noble and its modules from nginx.org. This " +
      "might take a few minutes.",
    "Upgrading to nginx 1.30.6-1~noble from nginx.org with apt. This might " +
      "take a few minutes.",
    "Removing everything the check added.",
  ]);
});

test("fails when nginx never reports the key before the upgrade", async () => {
  const { host } = fakeValidator({
    httpGet: async () => ({ status: 200, body: "locked\n" }),
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.equal(
    result.problems[0],
    "Before the upgrade the gate page says locked, so nginx never got the " +
      "api key.",
  );
  assert.equal(indexOfCall(host.calls, "nginx=1.30.6-1~noble"), -1);
});

test("waits out a connection dropped while the old nginx shuts down", async () => {
  let dropped = false;
  const validator = fakeValidator({
    httpGet: async () => {
      if (validator.state.installed === "1.30.6-1~noble" && !dropped) {
        dropped = true;
        throw new Error("socket hang up");
      }
      return { status: 200, body: "unlocked\n" };
    },
  });
  const { result } = await runCheck(validator.host);
  assert.equal(dropped, true);
  assert.deepEqual(result, { passed: true, problems: [], leftovers: [] });
});

test("fails when the gate page never answers after the upgrade", async () => {
  const validator = fakeValidator({
    httpGet: async () => {
      if (validator.state.installed === "1.30.6-1~noble") {
        throw new Error("socket hang up");
      }
      return { status: 200, body: "unlocked\n" };
    },
  });
  const { result } = await runCheck(validator.host);
  assert.deepEqual(result.problems, [
    "After the upgrade the gate page never said unlocked; its last answer " +
      "was no answer (socket hang up).",
  ]);
});

test("fails when the old nginx main process keeps running", async () => {
  const { host } = fakeValidator({ state: { keepOldMain: true } });
  const { result } = await runCheck(host);
  assert.deepEqual(result.problems, [
    "The old nginx main process is still running.",
  ]);
});

test("reports what the clean-up couldn't remove", async () => {
  const { host } = fakeValidator({
    respond: (call) =>
      call.args?.includes("purge")
        ? { status: 1, stderr: "dpkg locked" }
        : undefined,
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.deepEqual(result.problems, []);
  assert.match(
    result.leftovers[0],
    /^Couldn't finish "Removing nginx and its modules": .*dpkg locked/,
  );
});

test("names every reason a machine can't run the check", () => {
  const problems = machineProblems({
    isRoot: true,
    osRelease: new Map([["ID", "debian"]]),
    systemdVersion: 249,
    nginxVersion: "1.24.0-2ubuntu7",
  });
  assert.equal(problems.length, 5);
  assert.deepEqual(
    machineProblems({
      isRoot: false,
      osRelease: new Map([
        ["ID", "ubuntu"],
        ["VERSION_CODENAME", "noble"],
      ]),
      systemdVersion: 255,
      nginxVersion: null,
    }),
    [],
  );
});

test("names every way nginx can fail the upgrade", () => {
  const before = new Map([
    ["ActiveState", "active"],
    ["InvocationID", "a"],
    ["MainPID", "1"],
  ]);
  const problems = upgradeProblems({
    before,
    after: new Map([
      ["ActiveState", "failed"],
      ["InvocationID", "b"],
      ["MainPID", "1"],
    ]),
    programAfter: "/usr/sbin/nginx (deleted)",
    oldMainRunning: true,
    gateAfter: "locked",
    installedVersion: null,
    expectedVersion: "1.30.6-1~noble",
  });
  assert.equal(problems.length, 7);
});

test("the test configuration listens on 127.0.0.1 alone, with the key", () => {
  const config = renderTestNginxConfig({
    port: 18080,
    njsModulePath:
      "/etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js",
  });
  assert.match(config, /^\s*listen 127\.0\.0\.1:18080;$/m);
  assert.match(config, /^env X1_RPC_KEY;$/m);
  assert.match(config, /^pid \/run\/nginx\.pid;$/m);
  assert.match(
    config,
    /js_import x1rpc from \/etc\/nginx\/x1-validator-private-rpc\/x1-validator-private-rpc\.js;/,
  );
});

test("the real entry point prints its help with exit code 0", () => {
  const entry = fileURLToPath(
    new URL("../util/validate-nginx-upgrade/index.js", import.meta.url),
  );
  const help = spawnSync(process.execPath, [entry, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.startsWith("Proves on this machine"));
  const refused = spawnSync(process.execPath, [entry, "--bogus"], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unknown option '--bogus'/);
});
