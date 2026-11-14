/**
 * @file x1-validator-private-rpc/test/undo-apply.test.js
 * @description
 * Tests undo-apply on a fake validator that apply set up:
 *
 * - every setting apply changed is reset, newest first, until the
 *   machine is as apply found it
 * - the api key and the saved password are deleted only when the
 *   operator says so, and their folders stay while they do
 * - a folder that was there keeps its mode and stays, even /run
 * - nginx.org's keyring that was there stays
 * - nginx and its account stay while nginx is still installed
 * - a folder stays when the settings moved it, or when it holds files
 *   apply didn't make
 * - after apply --acme-staging with every setting changed, both
 *   certificate folders, the key's hand-off folder and the log folder
 *   go from where the settings put them
 * - the dry run changes nothing
 * - a step that fails stays recorded, and a second undo-apply retries it
 * - a setting this version can't reset stays recorded
 * - with nothing recorded, there's nothing to do
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runApply } from "../src/cli/apply.js";
import { HTTPS_RULE } from "../src/cli/apply-install.js";
import { featurePaths, homePath } from "../src/cli/feature-paths.js";
import { readState } from "../src/cli/state.js";
import { runUndoApply } from "../src/cli/undo-apply.js";
import {
  partsOf,
  readRecord,
  writeRecord,
} from "../src/cli/what-apply-changed.js";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  NGINX_UNIT,
} from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  appliedValidator,
  commandRun,
  PASSWORD,
} from "./helpers/applied-validator.js";
import {
  copyShippedConfig,
  shippedAndChangedSettings,
} from "./helpers/config-copies.js";
import {
  fakeX1Validator,
  HOME,
  HOSTNAME,
} from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Runs undo-apply.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @param {object} [more]  The answers and options.
 * @param {boolean} [more.yes]  The answer to its questions.
 * @param {boolean} [more.dryRun]  Whether it's a dry run.
 * @returns {Promise<{code: number, lines: string[], asked: string[]}>}
 */
async function undoApply(host, settings, { yes = true, dryRun = false } = {}) {
  const prompts = scriptedPrompts({ ask: () => yes });
  const run = commandRun(host, settings, { prompts, options: { dryRun } });
  const code = await runUndoApply(run);
  return { code, lines: run.lines, asked: prompts.asked };
}

/**
 * Lists the recorded settings, by name and target, oldest first.
 * @param {object} host  The fake host.
 * @returns {{name: string, target: string}[]}
 */
function recorded(host) {
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  return [...record.keys()].map((key) => partsOf(key));
}

/**
 * Lists the targets of the recorded settings with one name.
 * @param {object} host  The fake host.
 * @param {string} name  The settings' name.
 * @returns {string[]}
 */
function targetsNamed(host, name) {
  return recorded(host)
    .filter((parts) => parts.name === name)
    .map((parts) => parts.target);
}

/**
 * Reads the fixture start script.
 * @returns {string}
 */
function fixtureScript() {
  return fs.readFileSync(
    fileURLToPath(new URL("fixtures/start_validator.sh", import.meta.url)),
    "utf8",
  );
}

test("undoes everything apply did, newest first, until nothing is left", async () => {
  const { host, state, settings, scriptPath } = await appliedValidator(
    {},
    { savePassword: true },
  );
  const paths = featurePaths();
  const vault = homePath(settings.vaultPath, HOME);
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  const [backup] = targetsNamed(host, "startScriptBackup");
  const repository = ["nginxAptKeyring", "nginxAptSource", "nginxAptPin"]
    .map((name) => targetsNamed(host, name))
    .flat();
  assert.equal(repository.length, 3);
  const { code, lines, asked } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(scriptPath), fixtureScript());
  assert.equal(state.crontab, "");
  assert.deepEqual(
    [state.active, state.enabled, state.masked],
    [false, false, false],
  );
  assert.deepEqual([state.nginxInstalled, state.nginxUser], [false, false]);
  assert.equal(state.ufwRules.includes(HTTPS_RULE), false);
  for (const filePath of [
    path.join(x1consoleDir, ".git", "hooks", "post-merge"),
    backup,
    settings.nginxConfigPath,
    path.dirname(settings.nginxConfigPath),
    settings.njsModulePath,
    settings.startWrapperPath,
    settings.systemdDropInPath,
    settings.logrotateRulePath,
    settings.nginxLogDir,
    settings.passwordCredentialPath,
    path.dirname(settings.passwordCredentialPath),
    vault,
    path.dirname(vault),
    path.dirname(path.dirname(vault)),
    paths.tmpDir,
    paths.logsDir,
    path.dirname(paths.whatApplyChangedPath),
    ...repository,
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
  assert.equal(asked.length, 2);
  for (const folder of [
    path.dirname(settings.keyHandOffPath),
    settings.acmeStatePath,
  ]) {
    assert.ok(
      host.calls.some(
        (call) => call.kind === "removeRootTree" && call.path === folder,
      ),
      folder,
    );
  }
  const sourceGone = host.calls.findIndex(
    (call) =>
      call.kind === "removeRootFile" && call.path === NGINX_APT_SOURCE_PATH,
  );
  const refreshed = host.calls.findLastIndex(
    (call) => call.command === "apt" && call.args.at(-1) === "update",
  );
  assert.ok(sourceGone >= 0 && refreshed > sourceGone);
  const order = [
    "Done: remove the line that runs ensure",
    "Done: take --private-rpc out of",
    "Done: remove the nginx package.",
    `Done: unmask ${NGINX_UNIT}.`,
  ].map((start) => lines.findIndex((line) => line.includes(start)));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(
    order.every((index) => index >= 0),
    lines.join("\n"),
  );
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
});

test("a folder that was there keeps its mode and stays, even /run for a hand-off file put straight in it", async () => {
  const override = JSON.stringify({
    hostname: HOSTNAME,
    keyHandOffPath: "/run/x1-validator-private-rpc-key",
  });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const credentialFolder = path.dirname(settings.passwordCredentialPath);
  // There already, as on Ubuntu 24.04, whose systemd makes it at boot.
  const { host } = fakeX1Validator({
    settings,
    files: new Map([[credentialFolder, ""]]),
  });
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts({
      ask: () => true,
      passwords: [PASSWORD, PASSWORD],
    }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  const remade = host.calls.filter(
    (call) => call.command === "install" && call.args[0] === "-d",
  );
  assert.deepEqual(remade, []);
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const handOff = record.get("keyHandOffFolder:/run");
  assert.equal(handOff.applyChangedThisFromItsPreviousValue, false);
  assert.equal(record.has(`savedPasswordFolder:${credentialFolder}`), false);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(host.files.has("/run") && host.files.has(credentialFolder));
  assert.equal(
    host.calls.some(
      (call) => call.kind === "removeRootTree" && call.path === "/run",
    ),
    false,
  );
});

test("nginx.org's keyring that was there before apply stays, while the files apply wrote go", async () => {
  const theirs = "the operator's keyring";
  const { host, settings } = await appliedValidator({
    files: new Map([[NGINX_KEYRING_PATH, theirs]]),
  });
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const keyring = record.get(`nginxAptKeyring:${NGINX_KEYRING_PATH}`);
  assert.equal(keyring.applyChangedThisFromItsPreviousValue, false);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(host.files.get(NGINX_KEYRING_PATH), theirs);
  for (const filePath of [NGINX_APT_SOURCE_PATH, NGINX_APT_PIN_PATH]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("keeps the api key and the saved password when told no, with their folders, until a later run", async () => {
  const { host, settings } = await appliedValidator({}, { savePassword: true });
  const paths = featurePaths();
  const vault = homePath(settings.vaultPath, HOME);
  const credentialFolder = path.dirname(settings.passwordCredentialPath);
  const { code, lines } = await undoApply(host, settings, { yes: false });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(host.files.has(vault));
  assert.ok(host.files.has(settings.passwordCredentialPath));
  assert.deepEqual(
    recorded(host).map((parts) => parts.name),
    [
      "vaultFolder",
      "vaultFolder",
      "vault",
      "apiKey",
      "savedPasswordFolder",
      "savedPassword",
    ],
  );
  assert.ok(
    lines.includes(
      `[undo-apply] Kept, since ${settings.passwordCredentialPath} stays: the change behind "remove the folder ${credentialFolder}".`,
    ),
  );
  assert.equal(readState(host, paths.statePath).setup, null);
  const later = await undoApply(host, settings);
  assert.equal(later.code, 0, later.lines.join("\n"));
  for (const filePath of [
    vault,
    path.dirname(vault),
    settings.passwordCredentialPath,
    credentialFolder,
    path.dirname(paths.whatApplyChangedPath),
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("the dry run says each step, and changes nothing", async () => {
  const { host, settings } = await appliedValidator();
  const before = host.calls.length;
  const files = [...host.files.keys()].sort();
  const { code, lines, asked } = await undoApply(host, settings, {
    dryRun: true,
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual([...host.files.keys()].sort(), files);
  assert.equal(
    host.calls.slice(before).filter((call) => call.kind !== "run").length,
    0,
  );
  assert.ok(
    lines.some((line) => line.includes("Would take --private-rpc out of")),
  );
  assert.ok(
    lines.includes(`[undo-apply] Would remove ${NGINX_APT_SOURCE_PATH}.`),
  );
  assert.equal(lines.at(-1), `[undo-apply] Would unmask ${NGINX_UNIT}.`);
});

test("nginx stays masked, and its account stays, while it's still installed, until a later run", async () => {
  let purgeWorks = false;
  const { host, state, settings } = await appliedValidator({
    respond: (call) =>
      call.args?.includes("purge") && !purgeWorks
        ? { status: 100, stderr: "E: Could not get lock" }
        : undefined,
  });
  const first = await undoApply(host, settings);
  assert.equal(first.code, 1);
  assert.deepEqual([state.masked, state.nginxUser], [true, true]);
  for (const stays of [
    "is still installed, so the mask stays until it's gone.",
    "is still installed, so its account stays until it's gone.",
  ]) {
    assert.ok(
      first.lines.some((line) => line.includes(stays)),
      stays,
    );
  }
  assert.deepEqual(
    recorded(host).map((parts) => parts.name),
    [
      "nginxServiceMasked",
      "nginxAccount",
      "nginxPackage",
      "nginxPackage",
      "nginxPackage",
    ],
  );
  purgeWorks = true;
  const second = await undoApply(host, settings);
  assert.equal(second.code, 0, second.lines.join("\n"));
  assert.deepEqual(
    [state.nginxInstalled, state.masked, state.nginxUser],
    [false, false, false],
  );
});

test("a folder stays when the settings moved it, or when others use it", async () => {
  const { host, settings } = await appliedValidator();
  const libexec = path.dirname(path.dirname(settings.startWrapperPath));
  host.files.set(`${libexec}/another-tool`, "");
  const moved = { ...settings, nginxLogDir: `${settings.nginxLogDir}-moved` };
  const { code, lines } = await undoApply(host, moved);
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(host.files.has(settings.nginxLogDir));
  assert.ok(host.files.has(libexec));
  assert.ok(
    lines.includes(
      `[undo-apply] ${settings.nginxLogDir} isn't where the settings now put it, so it stays; remove it by hand if apply made it.`,
    ),
  );
  assert.ok(
    lines.includes(
      `[undo-apply] ${libexec} holds files apply didn't make, so it stays.`,
    ),
  );
});

test("after apply --acme-staging with every setting changed, undo-apply removes the certificate, hand-off and log folders where the settings put them", async () => {
  const { changed } = shippedAndChangedSettings();
  const { host, settings } = await appliedValidator(
    { settings: { ...changed, hostname: HOSTNAME } },
    { acmeStaging: true },
  );
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
  const removed = host.calls
    .filter((call) => call.kind === "removeRootTree")
    .map((call) => call.path);
  const named = [
    changed.acmeStatePath,
    changed.acmeStagingStatePath,
    path.dirname(changed.keyHandOffPath),
    changed.nginxLogDir,
  ];
  assert.deepEqual(removed.sort(), named.sort());
});

test("a later apply keeps the first one's old values, replaces its own hook and cron line, and undo-apply removes all it made", async () => {
  const { host, state, settings, scriptPath } = await appliedValidator();
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  const hookPath = path.join(x1consoleDir, ".git", "hooks", "post-merge");
  await host.sleep(1000);
  host.files.set(scriptPath, fixtureScript());
  host.nodePath = () => "/opt/node-v22/bin/node";
  const again = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  const ensureLines = state.crontab
    .split("\n")
    .filter((line) => line.includes(" ensure "));
  assert.equal(ensureLines.length, 1);
  assert.ok(ensureLines[0].includes("/opt/node-v22/bin/node"));
  assert.ok(host.files.get(hookPath).includes("/opt/node-v22/bin/node"));
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(state.crontab, "");
  assert.equal(host.files.has(hookPath), false);
  assert.deepEqual(
    [state.ufwRules.includes(HTTPS_RULE), state.nginxInstalled],
    [false, false],
  );
  const backups = [...host.files.keys()].filter((name) =>
    name.startsWith(`${scriptPath}.bak-`),
  );
  assert.deepEqual(backups, []);
});

test("a setting this version can't reset stays recorded, and so does one whose old value says it was there", async () => {
  const { host, settings } = await appliedValidator();
  const recordPath = featurePaths().whatApplyChangedPath;
  const later = {
    description: "Something a later version sets up.",
    applyChangedThisFromItsPreviousValue: true,
    applyChangedThisValueAtThisTimestampMS: 0,
    oldValue: "false",
    oldValueDatatype: "boolean",
  };
  const there = { ...later, description: "A rule.", oldValue: "true" };
  const odd = [
    ["laterSetting:/a", later],
    ["firewallRule:8443/tcp", there],
  ];
  const record = readRecord(host, recordPath);
  writeRecord(host, recordPath, new Map([...odd, ...record]));
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  for (const [key] of odd) {
    assert.ok(
      lines.includes(
        `[undo-apply] Kept: ${key}, a change this version of the tool can't undo.`,
      ),
      key,
    );
  }
  assert.deepEqual([...readRecord(host, recordPath)], odd);
  assert.equal(
    host.calls.some(
      (call) => call.command === "ufw" && call.args.includes("8443/tcp"),
    ),
    false,
  );
});

test("a step that fails stays recorded, and a second undo-apply retries it", async () => {
  let ufwWorks = false;
  const { host, state, settings } = await appliedValidator({
    respond: (call) =>
      call.command === "ufw" && call.args[0] === "delete" && !ufwWorks
        ? { status: 1, stderr: "ERROR: Could not delete rule" }
        : undefined,
  });
  const first = await undoApply(host, settings);
  assert.equal(first.code, 1);
  assert.ok(
    first.lines.some((line) =>
      line.includes(`Couldn't run ufw delete allow ${HTTPS_RULE}: `),
    ),
  );
  assert.ok(state.ufwRules.includes(HTTPS_RULE));
  ufwWorks = true;
  const second = await undoApply(host, settings);
  assert.equal(second.code, 0, second.lines.join("\n"));
  assert.equal(state.ufwRules.includes(HTTPS_RULE), false);
});

test("with nothing recorded, there is nothing to undo", async () => {
  const { host } = fakeX1Validator();
  const { code, lines } = await undoApply(host, {});
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    "[undo-apply] apply hasn't changed anything here, so there is nothing to undo.",
  ]);
});
