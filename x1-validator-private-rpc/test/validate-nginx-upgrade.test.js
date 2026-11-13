/**
 * @file x1-validator-private-rpc/test/validate-nginx-upgrade.test.js
 * @description
 * Tests the nginx upgrade check on a fake host that plays a validator,
 * from helpers/fake-validator.js: the order of its steps, its verdict in each way the upgrade can go,
 * and its clean-up, which must remove everything it added even when a
 * step fails. Every scenario runs with each setting changed from its
 * shipped value, so a step that used a default instead would show. It
 * also tests the check's decisions and test configuration on their own,
 * and runs the real entry point for its help.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  NGINX_PACKAGES,
} from "../src/lib/nginx-org.js";
import {
  machineProblems,
  upgradeProblems,
} from "../util/validate-nginx-upgrade/judge.js";
import { renderTestNginxConfig } from "../util/validate-nginx-upgrade/render-test-config.js";
import { validateNginxUpgrade } from "../util/validate-nginx-upgrade/steps.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { fakeValidator } from "./helpers/fake-validator.js";

/** Text in the command line of the step that removes the packages. */
const PURGE = "purge --yes nginx";

/**
 * The settings every scenario runs with.
 * @returns {object} Each setting changed from its shipped value.
 */
function testSettings() {
  return shippedAndChangedSettings().changed;
}

/**
 * Runs the check on a fake validator, with the test settings.
 * @param {object} host  The fake host.
 * @param {object} [options]  More of validateNginxUpgrade's options, such
 *   as `wait` or `isInterrupted`.
 * @returns {Promise<{result: object, lines: string[]}>}
 */
async function runCheck(host, options = {}) {
  const lines = [];
  const result = await validateNginxUpgrade({
    host,
    settings: testSettings(),
    report: (line) => lines.push(line),
    ...options,
  });
  return { result, lines };
}

/**
 * Lists the fake's files and folders, leaving out /proc, which tracks
 * nginx's processes rather than anything the check writes.
 * @param {object} host  The fake host.
 * @returns {string[]} Their paths, sorted.
 */
function filesOutsideProc(host) {
  return [...host.files.keys()]
    .filter((name) => !name.startsWith("/proc/"))
    .sort();
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

test("uses every configured setting, and never a shipped value instead", async () => {
  const { shipped, changed } = shippedAndChangedSettings();
  const { host } = fakeValidator();
  const used = [];
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, content, mode) => {
    used.push(String(content));
    writeRootFile(filePath, content, mode);
  };
  const timeouts = [];
  for (const name of ["httpGet", "httpsGet"]) {
    const get = host[name];
    host[name] = (url, timeoutMs) => {
      timeouts.push(timeoutMs);
      return get(url, timeoutMs);
    };
  }
  const { result } = await runCheck(host, { settings: changed });
  assert.equal(result.passed, true);
  for (const call of host.calls) {
    used.push(call.path ?? [call.command, ...call.args].join(" "));
  }
  const text = used.join("\n");
  for (const [name, value] of Object.entries(shipped)) {
    if (typeof value === "string") {
      for (const shippedPath of [value, path.dirname(value)]) {
        assert.ok(!text.includes(shippedPath), `${name}: ${shippedPath} used`);
      }
      assert.ok(text.includes(changed[name]), `${name} was never used`);
    }
  }
  assert.ok(timeouts.length > 0);
  for (const timeoutMs of timeouts) {
    assert.equal(timeoutMs, changed.requestTimeoutSeconds * 1000);
  }
});

test("leaves the machine as it found it, every folder it made included", async () => {
  const { host } = fakeValidator();
  const before = filesOutsideProc(host);
  const { result } = await runCheck(host);
  assert.equal(result.passed, true);
  assert.deepEqual(filesOutsideProc(host), before);
});

test("hands over a well-formed test key in a file only root can read", async () => {
  const { host } = fakeValidator();
  const settings = testSettings();
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
  const settings = testSettings();
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

test("reports what the clean-up couldn't remove, and how to remove it by hand", async () => {
  const { host } = fakeValidator({
    respond: (call) =>
      call.args?.includes("purge")
        ? { status: 1, stderr: "dpkg locked" }
        : undefined,
  });
  const { result } = await runCheck(host);
  assert.equal(result.passed, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.leftovers.length, 1);
  assert.match(
    result.leftovers[0],
    new RegExp(
      `^Couldn't finish "Removing nginx and its modules": .*dpkg locked\\n` +
        `  By hand: sudo apt purge ${NGINX_PACKAGES.join(" ")}$`,
    ),
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
