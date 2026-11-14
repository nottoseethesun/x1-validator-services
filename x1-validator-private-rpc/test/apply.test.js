/**
 * @file x1-validator-private-rpc/test/apply.test.js
 * @description
 * Tests apply on a fake x1console validator:
 *
 * - a fresh machine through every stage, and a second apply that changes
 *   nothing
 * - the dry run, which changes nothing
 * - the preflight, which lists every problem at once
 * - a stop at a stage, which a later apply picks up from
 * - a file apply didn't write, which it refuses to replace
 * - another program's git hook, which stays
 * - the saved password, offered after systemd's TPM2 answer
 * - the settings apply follows: how long it waits for the certificate
 *   and how often it asks, the address it checks Let's Encrypt at, and
 *   where the start script is
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { HTTPS_RULE } from "../src/cli/apply-install.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { createLog } from "../src/cli/log.js";
import { readState } from "../src/cli/state.js";
import { API_KEY_SECRET, secretOf } from "../src/cli/vault.js";
import { readRecord } from "../src/cli/what-apply-changed.js";
import { GATE_PAGE_PATH } from "../src/lib/gate-page.js";
import { NGINX_PACKAGES, NGINX_UNIT } from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  copyShippedConfig,
  shippedAndChangedSettings,
} from "./helpers/config-copies.js";
import {
  fakeX1Validator,
  HOME,
  HOSTNAME,
  PUBLIC_IP,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const PASSWORD = "a long test password";

/** The path settings apply reads. */
const APPLY_PATHS = [
  "x1consoleDir",
  "vaultPath",
  "nginxConfigPath",
  "njsModulePath",
  "startWrapperPath",
  "systemdDropInPath",
  "logrotateRulePath",
  "passwordCredentialPath",
  "keyHandOffPath",
  "acmeStatePath",
  "acmeStagingStatePath",
  "nginxLogDir",
];

/**
 * Loads the shipped settings with the hostname set.
 * @param {object} [more]  More of the operator's settings.
 * @returns {object}
 */
function operatorSettings(more = {}) {
  const override = JSON.stringify({ hostname: HOSTNAME, ...more });
  return loadSettings(copyShippedConfig(override).configDir);
}

/**
 * Runs apply on a fake validator.
 * @param {object} host  The fake host.
 * @param {object} [run]  More of the run: prompts, options, settings.
 * @returns {Promise<{code: number, lines: string[]}>}
 */
async function apply(host, run = {}) {
  const lines = [];
  const log = createLog({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  const code = await runApply({
    host,
    settings: run.settings ?? operatorSettings(),
    overridePath: "/operator/private-rpc.json",
    paths: featurePaths(),
    log,
    prompts:
      run.prompts ?? scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false, ...run.options },
  });
  return { code, lines };
}

/**
 * Lists the calls that change the machine.
 * @param {object[]} calls  The fake's calls.
 * @returns {string[]}
 */
function changingCalls(calls) {
  const reads = [
    "ufw show added",
    "systemctl --version",
    "systemctl is-active",
    "test -e",
  ];
  return calls
    .filter(
      (call) =>
        call.kind !== "run" ||
        (call.command === "crontab" && call.args[0] === "-"),
    )
    .map((call) =>
      call.command === undefined
        ? `${call.kind} ${call.path}`
        : [call.kind, call.command, ...call.args].join(" "),
    )
    .filter((line) => !reads.some((read) => line.includes(read)));
}

test("a fresh validator goes through every stage, and a second apply changes nothing", async () => {
  const settings = operatorSettings();
  const { host, state, scriptPath } = fakeX1Validator();
  const { code, lines } = await apply(host, { settings });
  assert.equal(code, 0, lines.join("\n"));
  const logFolder = host.calls.find(
    (call) => call.kind === "makeRootDir" && call.path === settings.nginxLogDir,
  );
  // Only root and nginx may open the folder, and so read the logs.
  assert.deepEqual([logFolder.mode, logFolder.group], ["0750", "nginx"]);
  assert.equal(state.nginxInstalled, true);
  assert.deepEqual(
    [state.masked, state.enabled, state.active, state.unlocked],
    [false, true, true, true],
  );
  assert.ok(state.ufwRules.includes(HTTPS_RULE));
  assert.match(state.crontab, / ensure --quiet >> /);
  assert.match(
    host.files.get(scriptPath),
    /^ {4}--rpc-port 8899 --private-rpc \\$/m,
  );
  const recorded = readState(host, featurePaths().statePath);
  assert.deepEqual(recorded.setup, {
    hostname: HOSTNAME,
    publicIp: PUBLIC_IP,
    rpcPort: 8899,
    staging: false,
  });
  assert.ok(lines.some((line) => line.includes("Restart it from x1console")));
  assert.ok(
    lines.some((line) =>
      /The rpc's url: https:\/\/x1-rpc\.example\.com\/…[0-9a-f]{4}$/.test(line),
    ),
  );
  const before = host.calls.length;
  const again = await apply(host, {
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
  });
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.deepEqual(changingCalls(host.calls.slice(before)), []);
});

test("the dry run says every change it would make, and makes none", async () => {
  const settings = operatorSettings();
  const { host } = fakeX1Validator();
  const prompts = scriptedPrompts();
  const { code, lines } = await apply(host, {
    settings,
    prompts,
    options: { dryRun: true },
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(changingCalls(host.calls), []);
  for (const would of [
    `Would mask ${NGINX_UNIT}`,
    `Would install ${NGINX_PACKAGES.join(", ")}`,
    `Would run ufw allow ${HTTPS_RULE}`,
    `Would write ${settings.nginxConfigPath}`,
    "Would add --private-rpc to",
    "Would add the line that runs ensure to the crontab",
  ]) {
    assert.ok(
      lines.some((line) => line.includes(would)),
      would,
    );
  }
  assert.deepEqual(prompts.asked, []);
});

test("the preflight lists every problem at once, and changes nothing", async () => {
  const { host } = fakeX1Validator({
    state: { nginxInstalled: true, active: true },
    files: new Map([
      [
        "/home/validator/.config/solana/cli/config.yml",
        `json_rpc_url: "http://${PUBLIC_IP}:8899"\n`,
      ],
    ]),
  });
  const settings = loadSettings(copyShippedConfig().configDir);
  await assert.rejects(apply(host, { settings }), (error) => {
    for (const problem of [
      /Set hostname in \/operator\/private-rpc\.json/,
      /nginx 1\.30\.6-1~noble is already installed, by something other than this tool/,
      /Something already listens on port 443/,
    ]) {
      assert.match(error.message, problem);
    }
    return true;
  });
  const withHostname = fakeX1Validator({
    files: new Map([
      [
        "/home/validator/.config/solana/cli/config.yml",
        `json_rpc_url: "http://${PUBLIC_IP}:8899"\n`,
      ],
    ]),
  });
  await assert.rejects(apply(withHostname.host), {
    message:
      /The solana cli's url, http:\/\/203\.0\.113\.10:8899, names this validator/,
  });
  assert.deepEqual(changingCalls(host.calls), []);
});

test("a stop at a stage changes nothing after it, and a later apply picks up", async () => {
  const { host, state } = fakeX1Validator();
  const prompts = scriptedPrompts({
    confirm: (question) => !question.startsWith("Stage 3 of 8"),
  });
  const { code, lines } = await apply(host, { prompts });
  assert.equal(code, 1);
  assert.ok(
    lines.some((line) =>
      line.includes("Stopped. Running apply again picks up from here."),
    ),
  );
  assert.equal(state.nginxInstalled, true);
  assert.equal(state.ufwRules.includes("443/tcp"), false);
  const later = await apply(host);
  assert.equal(later.code, 0, later.lines.join("\n"));
  assert.ok(
    later.lines.some((line) => line.includes("nginx is installed already.")),
  );
});

test("a vault whose api key is null gets a new key, under a new password", async () => {
  const settings = operatorSettings();
  const { host } = fakeX1Validator();
  const homeDir = host.homeDir();
  const vaultPath = homePath(settings.vaultPath, homeDir);
  const vault = { version: 1, secrets: { [API_KEY_SECRET]: null } };
  host.files.set(vaultPath, JSON.stringify(vault));
  const prompts = scriptedPrompts({ passwords: [PASSWORD, PASSWORD] });
  const { code, lines } = await apply(host, { settings, prompts });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(prompts.asked.includes("A new x1-validator-services password: "));
  const written = JSON.parse(host.files.get(vaultPath));
  const stored = secretOf(written, API_KEY_SECRET);
  assert.equal(typeof stored, "object");
  assert.notEqual(stored, null);
});

test("refuses to replace a file apply didn't write", async () => {
  const settings = operatorSettings();
  const { host } = fakeX1Validator({
    files: new Map([
      [settings.nginxConfigPath, "# someone else's nginx.conf\n"],
    ]),
  });
  await assert.rejects(apply(host, { settings }), {
    message: `${settings.nginxConfigPath} exists, and apply didn't write it. Move it away, then run apply again.`,
  });
});

test("another program's git hook stays as it is, and out of the record", async () => {
  const settings = operatorSettings();
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  const hookPath = path.join(x1consoleDir, ".git", "hooks", "post-merge");
  const theirs = '#!/bin/sh\nexec git lfs post-merge "$@"\n';
  const { host } = fakeX1Validator({
    settings,
    files: new Map([[hookPath, theirs]]),
  });
  const { code, lines } = await apply(host, { settings });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(hookPath), theirs);
  assert.ok(
    lines.some((line) =>
      line.includes("is another program's hook, so it stays"),
    ),
  );
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  assert.equal(record.has(`gitHook:${hookPath}`), false);
});

test("the password is saved only when asked to, and a later apply sees it saved", async () => {
  const settings = operatorSettings();
  const { host } = fakeX1Validator();
  const prompts = scriptedPrompts({
    ask: () => true,
    passwords: [PASSWORD, PASSWORD],
  });
  const { code, lines } = await apply(host, { settings, prompts });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(
    lines.some((line) => line.includes("This machine has no usable TPM2 chip")),
  );
  const encrypt = host.calls.find(
    (call) => call.command === "systemd-creds" && call.args[0] === "encrypt",
  );
  assert.equal(encrypt.input, PASSWORD);
  assert.equal(encrypt.args.at(-1), settings.passwordCredentialPath);
  assert.match(
    host.files.get(settings.systemdDropInPath),
    /^LoadCredentialEncrypted=/m,
  );
  assert.equal(lines.join("\n").includes(PASSWORD), false);
  const again = scriptedPrompts({ ask: () => false, passwords: [PASSWORD] });
  const second = await apply(host, { settings, prompts: again });
  assert.equal(second.code, 0, second.lines.join("\n"));
  assert.ok(second.lines.includes("[key] The password is saved already."));
  assert.equal(
    again.asked.some((question) => question.startsWith("Save the password")),
    false,
  );
  assert.match(
    host.files.get(settings.systemdDropInPath),
    /^LoadCredentialEncrypted=/m,
  );
});

test("the preflight also names a wrong release, old systemd, missing tools and a wrong address", async () => {
  const { changed } = shippedAndChangedSettings();
  // A changed address, to show the check asks the one the settings name.
  const settings = operatorSettings({
    acmeDirectoryUrl: changed.acmeDirectoryUrl,
  });
  const { host } = fakeX1Validator({
    files: new Map([
      [
        "/etc/os-release",
        'ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n',
      ],
      ["/etc/resolv.conf", "# no nameserver\n"],
    ]),
    respond: (call) => {
      const line = [call.command, ...call.args].join(" ");
      if (line === "systemctl --version") {
        return { stdout: "systemd 249 (249.11)\n" };
      }
      return undefined;
    },
  });
  host.files.delete("/usr/sbin/ufw");
  host.localIpv4Addresses = () => ["127.0.0.1"];
  host.lookupIpv4 = async () => ["198.51.100.99"];
  host.httpsGet = async () => ({ status: 503, body: "" });
  await assert.rejects(apply(host, { settings }), (error) => {
    for (const problem of [
      "This isn't Ubuntu 24.04 or later.",
      "systemd 250 or newer is needed, for systemd-creds; this machine has 249.",
      "ufw isn't installed.",
      `${PUBLIC_IP} isn't on any of this machine's interfaces`,
      `${HOSTNAME} points to 198.51.100.99, not to ${PUBLIC_IP}.`,
      `${settings.acmeDirectoryUrl} didn't answer (http 503)`,
      "/etc/resolv.conf names no nameserver for nginx to use.",
    ]) {
      assert.ok(error.message.includes(problem), problem);
    }
    return true;
  });
});

test("without an answer from the local rpc, the address comes from publicIp, or apply stops", async () => {
  const { host } = fakeX1Validator();
  host.postJson = async () => ({ status: 502, body: "" });
  await assert.rejects(apply(host), {
    message:
      /The local rpc didn't say which address the X1 network has for this validator\. Set publicIp in \/operator\/private-rpc\.json\./,
  });
  const fromSettings = await apply(host, {
    settings: operatorSettings({ publicIp: PUBLIC_IP }),
  });
  assert.equal(fromSettings.code, 0, fromSettings.lines.join("\n"));
});

test("with --acme-staging, nginx gets the staging issuer, and the checks trust its roots", async () => {
  const settings = operatorSettings();
  const { host } = fakeX1Validator();
  const roots = [];
  const tlsGet = host.tlsGet;
  host.tlsGet = (target) => {
    roots.push(target.ca ?? "");
    return tlsGet(target);
  };
  const { code, lines } = await apply(host, {
    settings,
    options: { acmeStaging: true },
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(
    host.files.get(settings.nginxConfigPath),
    /acme_certificate letsencrypt-staging;/,
  );
  assert.ok(
    roots.length > 0 &&
      roots.every((pem) => pem.includes("(STAGING) Pretend Pear X1")),
  );
});

test("stops when the request path fails a check from the server", async () => {
  const { host } = fakeX1Validator();
  const tlsGet = host.tlsGet;
  host.tlsGet = async (target) =>
    target.path.endsWith("/health")
      ? { status: 502, body: "Bad Gateway", certificate: {} }
      : tlsGet(target);
  await assert.rejects(apply(host), {
    message: "The keyed path's health check answered 502: Bad Gateway",
  });
});

test("a run after one that failed with nginx started still records nginx's setup", async () => {
  const { host } = fakeX1Validator();
  const tlsGet = host.tlsGet;
  host.tlsGet = async (target) =>
    target.path.endsWith("/health")
      ? { status: 503, body: "behind", certificate: {} }
      : tlsGet(target);
  await assert.rejects(apply(host), { message: /answered 503: behind/ });
  host.tlsGet = tlsGet;
  const again = await apply(host, {
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
  });
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.ok(
    again.lines.includes("[nginx] nginx runs unlocked, with nothing changed."),
  );
  const recorded = readState(host, featurePaths().statePath);
  assert.equal(recorded.setup?.hostname, HOSTNAME);
});

test("apply waits for the certificate as long, and asks as often, as the settings say", async () => {
  const shipped = operatorSettings();
  const settings = operatorSettings({
    certificateWaitSeconds: shipped.certificateWaitSeconds * 2,
    gatePollMs: shipped.gatePollMs * 2,
  });
  const { host } = fakeX1Validator();
  const asked = [];
  const tlsGet = host.tlsGet;
  host.tlsGet = async (target) => {
    if (target.path !== GATE_PAGE_PATH) {
      return tlsGet(target);
    }
    asked.push(host.now());
    return { status: 200, body: "locked\n", certificate: {} };
  };
  await assert.rejects(apply(host, { settings }), {
    message: "No certificate, or no key, in time: the gate page says locked.",
  });
  const waited = asked.at(-1) - asked[0];
  const gaps = new Set(asked.slice(1).map((at, index) => at - asked[index]));
  assert.deepEqual(
    [waited, [...gaps]],
    [settings.certificateWaitSeconds * 1000, [settings.gatePollMs]],
  );
});

test("with --acme-staging, apply uses every configured path, address and timeout, and never a shipped one", async () => {
  const { shipped, changed } = shippedAndChangedSettings();
  const settings = { ...changed, hostname: HOSTNAME };
  const { host } = fakeX1Validator({ settings, telegram: true });
  const urls = [];
  const timeouts = [];
  for (const name of ["httpsGet", "postJson"]) {
    const ask = host[name];
    host[name] = (...args) => {
      urls.push(args[0]);
      timeouts.push(args.at(-1));
      return ask(...args);
    };
  }
  const tlsGet = host.tlsGet;
  host.tlsGet = (target) => {
    timeouts.push(target.timeoutMs);
    return tlsGet(target);
  };
  const prompts = scriptedPrompts({
    ask: () => true,
    passwords: [PASSWORD, PASSWORD],
  });
  const { code, lines } = await apply(host, {
    settings,
    prompts,
    options: { acmeStaging: true },
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(urls.includes(changed.acmeStagingDirectoryUrl), urls.join("\n"));
  assert.ok(!urls.includes(shipped.acmeStagingDirectoryUrl));
  const touched = host.calls
    .map((call) => call.path ?? [call.command, ...call.args].join(" "))
    .join("\n");
  for (const name of APPLY_PATHS) {
    const shippedPath = homePath(shipped[name], HOME);
    const changedPath = homePath(changed[name], HOME);
    assert.ok(!touched.includes(shippedPath), `${name}: ${shippedPath} used`);
    assert.ok(touched.includes(changedPath), `${name} was never used`);
  }
  assert.deepEqual(
    [...new Set(timeouts)],
    [changed.requestTimeoutSeconds * 1000],
  );
});

test("apply edits the start script the settings name, in the folder they name", async () => {
  const { changed } = shippedAndChangedSettings();
  const settings = operatorSettings({
    x1consoleDir: changed.x1consoleDir,
    startScriptFile: changed.startScriptFile,
  });
  const { host, scriptPath } = fakeX1Validator({ settings });
  const { code, lines } = await apply(host, { settings });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(
    host.files.get(scriptPath),
    /^ {4}--rpc-port 8899 --private-rpc \\$/m,
  );
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  const hook = path.join(x1consoleDir, ".git", "hooks", "post-merge");
  assert.ok(host.files.has(hook), hook);
});
