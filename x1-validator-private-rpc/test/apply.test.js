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
 *   and how often it asks, the address it checks Let's Encrypt at, every
 *   path, inside the files it writes too, and where the start script is
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { HTTPS_RULE } from "../src/cli/apply-install.js";
import { SAVE_PASSWORD_QUESTION } from "../src/cli/apply-key.js";
import {
  featurePaths,
  gitHookPathOf,
  hashedApiKeysPathOf,
} from "../src/cli/feature-paths.js";
import { createLog } from "../src/cli/log.js";
import {
  renderCronLine,
  renderGitHook,
  renderKeyCountCronLine,
} from "../src/cli/render-watchers.js";
import { RESTART_HOW } from "../src/cli/start-script.js";
import { readState } from "../src/cli/state.js";
import { readRecord } from "../src/cli/what-apply-changed.js";
import { makeApiKey } from "../src/lib/api-key.js";
import { GATE_PAGE_PATH } from "../src/lib/gate-page.js";
import { hashApiKey } from "../src/lib/key-hash-map.js";
import { NGINX_PACKAGES, NGINX_UNIT } from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import { MIN_SYSTEMD_VERSION } from "../src/lib/systemd.js";
import {
  copyShippedConfig,
  shippedAndChangedSettings,
  wrongPaths,
} from "./helpers/config-copies.js";
import { printedKeys } from "./helpers/applied-validator.js";
import {
  autopilotCrontab,
  fakeX1Validator,
  HOME,
  HOSTNAME,
  PUBLIC_IP,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

const PASSWORD = "a long test password";

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
 * @returns {Promise<{code: number, lines: string[], printed: string[]}>}
 *   The exit code, the log's lines, and what apply printed as is.
 */
async function apply(host, run = {}) {
  const lines = [];
  const printed = [];
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
    out: (line) => printed.push(line),
    options: { yes: false, dryRun: false, acmeStaging: false, ...run.options },
  });
  return { code, lines, printed };
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
  // A lock changes nothing on disk, and goes when its holder ends.
  const locks = ["lockFolder", "unlockFolder"];
  return calls
    .filter(
      (call) =>
        call.kind !== "run" ||
        (call.command === "crontab" && call.args[0] === "-"),
    )
    .filter((call) => !locks.includes(call.kind))
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
  const { code, lines, printed } = await apply(host, { settings });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(state.nginxInstalled, true);
  // The mask comes before the install, so the package's default site
  // never runs.
  const changes = changingCalls(host.calls).join("\n");
  const mask = `systemctl mask ${NGINX_UNIT}`;
  assert.match(changes, new RegExp(`${mask}\n[^]* apt .* install `));
  assert.deepEqual(
    [state.masked, state.enabled, state.active],
    [false, true, true],
  );
  // The key's two urls, printed once, in full, and nginx knows its hash.
  const [key] = printedKeys(printed);
  assert.deepEqual(printed, [
    `https://${HOSTNAME}/${key}`,
    `wss://${HOSTNAME}/${key}`,
  ]);
  assert.deepEqual(state.loadedHashes, [hashApiKey(key)]);
  assert.equal(lines.join("\n").includes(key), false);
  assert.ok(state.ufwRules.includes(HTTPS_RULE));
  // The cron lines and the git hook run the tool's own command.
  const paths = featurePaths();
  const tool = { nodeBin: host.nodePath(), toolCli: paths.toolCli };
  const logPath = paths.ensureLogPath;
  const hours = settings.apiKeyCountCheckHours;
  const table = state.crontab.split("\n");
  for (const line of [
    renderCronLine({ ...tool, lockPath: paths.lockPath, logPath }),
    renderKeyCountCronLine({ ...tool, logPath, hours }),
  ]) {
    assert.ok(table.includes(line), state.crontab);
  }
  const hookPath = gitHookPathOf(settings, HOME);
  assert.equal(host.files.get(hookPath), renderGitHook(tool));
  // Autopilot's jobs stay in the table.
  assert.ok(state.crontab.includes(autopilotCrontab()), state.crontab);
  // apply makes and records both folders, so undo-apply removes them.
  assert.ok(host.exists(paths.tmpDir) && host.exists(paths.logsDir));
  // git skips a hook it can't run, so the hook must be executable.
  assert.equal(host.fileMode(hookPath), 0o755);
  assert.match(
    host.files.get(scriptPath),
    /^ {4}--rpc-port 8899 --private-rpc \\$/m,
  );
  /*-
   * x1console's restart runs the start script itself, so it stays
   * executable.
   */
  assert.equal(host.fileMode(scriptPath), 0o755);
  const recorded = readState(host, paths.statePath);
  assert.deepEqual(recorded.setup, {
    hostname: HOSTNAME,
    publicIp: PUBLIC_IP,
    rpcPort: 8899,
    staging: false,
  });
  assert.ok(lines.some((line) => line.endsWith(RESTART_HOW)));
  assert.ok(
    lines.includes(
      `[hand-over] The rpc's url: https://${HOSTNAME}/…${key.slice(-4)}, shown in full above, and only there.`,
    ),
  );
  // The second run makes no key, asks for no password, and prints no url.
  const before = host.calls.length;
  const prompts = scriptedPrompts();
  const again = await apply(host, { prompts });
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.deepEqual(changingCalls(host.calls.slice(before)), []);
  assert.deepEqual(again.printed, []);
  assert.ok(prompts.asked.every((question) => question.startsWith("Stage ")));
  assert.ok(
    again.lines.includes(
      `[hand-over] The rpc's url: https://${HOSTNAME}/KEY, with an api key in place of KEY.`,
    ),
  );
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
    "Would make the first api key",
    "Would add the tool's two lines to the crontab",
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
  // The validator's own address, and a keyed url the refusal must not quote.
  const key = makeApiKey();
  for (const url of [
    `http://${PUBLIC_IP}:8899`,
    `https://${HOSTNAME}/${key}`,
  ]) {
    const named = fakeX1Validator({
      files: new Map([
        [
          "/home/validator/.config/solana/cli/config.yml",
          `json_rpc_url: "${url}"\n`,
        ],
      ]),
    });
    await assert.rejects(apply(named.host), (error) => {
      assert.match(
        error.message,
        /The solana cli's url names this validator's address or hostname/,
      );
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
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
  assert.equal(state.ufwRules.includes(HTTPS_RULE), false);
  const later = await apply(host);
  assert.equal(later.code, 0, later.lines.join("\n"));
  assert.ok(
    later.lines.some((line) => line.includes("nginx is installed already.")),
  );
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
  const hookPath = gitHookPathOf(settings, HOME);
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
  assert.ok(prompts.asked.includes(SAVE_PASSWORD_QUESTION));
  // nginx never needs it, so its drop-in doesn't name it.
  assert.doesNotMatch(host.files.get(settings.systemdDropInPath), /Credential/);
  assert.equal(lines.join("\n").includes(PASSWORD), false);
  const again = scriptedPrompts({ ask: () => false });
  const second = await apply(host, { settings, prompts: again });
  assert.equal(second.code, 0, second.lines.join("\n"));
  const filePath = hashedApiKeysPathOf(settings, HOME);
  assert.ok(
    second.lines.includes(`[keys] ${filePath} holds 1 api key already.`),
  );
  assert.ok(again.asked.every((question) => question.startsWith("Stage ")));
  assert.ok(host.files.has(settings.passwordCredentialPath));
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
        const old = MIN_SYSTEMD_VERSION - 1;
        return { stdout: `systemd ${old} (${old}.11)\n` };
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
      `systemd ${MIN_SYSTEMD_VERSION} or newer is needed, for systemd-creds. This machine has ${MIN_SYSTEMD_VERSION - 1}.`,
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
    message:
      /^Asked through nginx with the new key, the rpc's \/health answered 502: Bad Gateway$/m,
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
  const again = await apply(host, { prompts: scriptedPrompts() });
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.ok(again.lines.includes("[nginx] nginx runs, with nothing changed."));
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
    return { status: 503, body: "", certificate: {} };
  };
  await assert.rejects(apply(host, { settings }));
  const waited = asked.at(-1) - asked[0];
  const gaps = new Set(asked.slice(1).map((at, index) => at - asked[index]));
  assert.deepEqual(
    [waited, [...gaps]],
    [settings.certificateWaitSeconds * 1000, [settings.gatePollMs]],
  );
});

test("with --acme-staging, apply uses every configured path, address and timeout, and never a shipped one, in its calls or inside the files it writes", async () => {
  const { shipped, changed } = shippedAndChangedSettings();
  const settings = { ...changed, hostname: HOSTNAME };
  const { host } = fakeX1Validator({ settings, telegram: true });
  const written = [];
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, content, mode) => {
    written.push(String(content));
    writeRootFile(filePath, content, mode);
  };
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
  const telegramApi = "https://api.telegram.org/";
  const alerts = host.posts.filter((post) => post.url.startsWith(telegramApi));
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].body.text.includes(HOSTNAME), alerts[0].body.text);
  assert.ok(urls.includes(changed.acmeStagingDirectoryUrl), urls.join("\n"));
  assert.ok(!urls.includes(shipped.acmeStagingDirectoryUrl));
  assert.deepEqual(wrongPaths(host.calls, shipped, changed, HOME, written), {
    shippedUsed: [],
    changedUnused: [],
  });
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
  const hook = gitHookPathOf(settings, HOME);
  assert.ok(host.files.has(hook), hook);
});
