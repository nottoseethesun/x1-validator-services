/**
 * @file x1-validator-private-rpc/test/undo-apply.test.js
 * @description
 * Tests undo-apply on a fake validator that apply set up:
 *
 * - every setting apply changed is reset, newest first, until the
 *   machine is as apply found it, the api keys and the saved password
 *   going after one question asked before any step. Their other cases
 *   are in undo-apply-api-keys.test.js. Only the flag comes out of the
 *   start script, so a change an x1console update made since stays.
 * - a folder that was there keeps its mode and stays
 * - nginx.org's keyring that was there stays
 * - nginx and its account stay while nginx is still installed
 * - a folder stays when the settings moved it, or when it holds files
 *   apply didn't make
 * - after apply --acme-staging with every setting changed and the
 *   password saved, the files are as apply found them, and undo-apply
 *   used each configured path and never a shipped one
 * - every folder apply made for the saved password goes, however many
 *   were missing, and inside a folder only root can look into, one apply
 *   made goes while one that was there stays
 * - the dry run changes nothing
 * - a step that fails stays recorded, and a second undo-apply retries it
 * - while another command holds the start script's lock, the flag stays
 *   recorded, and a second undo-apply takes it out
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
import {
  featurePaths,
  gitHookPathOf,
  hashedApiKeysPathOf,
} from "../src/cli/feature-paths.js";
import { lockStartScript, START_SCRIPT_LOCKED } from "../src/cli/state.js";
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
  wrongPaths,
} from "./helpers/config-copies.js";
import {
  autopilotCrontab,
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
  const keysFile = hashedApiKeysPathOf(settings, HOME);
  const [backup] = targetsNamed(host, "startScriptBackup");
  const repository = ["nginxAptKeyring", "nginxAptSource", "nginxAptPin"]
    .map((name) => targetsNamed(host, name))
    .flat();
  assert.equal(repository.length, 3);
  // An x1console update changes another line, after apply added the flag.
  const before = "--maximum-full-snapshots-to-retain 50";
  const after = "--maximum-full-snapshots-to-retain 25";
  const withFlag = host.files.get(scriptPath);
  assert.ok(withFlag.includes(before));
  host.files.set(scriptPath, withFlag.replace(before, after));
  const { code, lines, asked } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  // Only the flag comes out, never apply's older backup.
  assert.equal(
    host.files.get(scriptPath),
    fixtureScript().replace(before, after),
  );
  assert.equal(host.fileMode(scriptPath), 0o755);
  // Only the tool's lines go: Autopilot's stay.
  assert.equal(state.crontab, autopilotCrontab());
  assert.deepEqual(
    [state.active, state.enabled, state.masked],
    [false, false, false],
  );
  assert.deepEqual([state.nginxInstalled, state.nginxUser], [false, false]);
  assert.equal(state.ufwRules.includes(HTTPS_RULE), false);
  for (const filePath of [
    gitHookPathOf(settings, HOME),
    backup,
    settings.nginxConfigPath,
    path.dirname(settings.nginxConfigPath),
    settings.njsModulePath,
    settings.hashedApiKeysMapPath,
    settings.systemdDropInPath,
    settings.passwordCredentialPath,
    path.dirname(settings.passwordCredentialPath),
    keysFile,
    path.dirname(keysFile),
    path.dirname(path.dirname(keysFile)),
    paths.tmpDir,
    paths.logsDir,
    path.dirname(paths.whatApplyChangedPath),
    ...repository,
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
  assert.equal(asked.length, 1);
  assert.ok(
    asked[0].startsWith("Delete every api key and the saved password?"),
    asked[0],
  );
  // The question comes before any step.
  assert.equal(
    lines[0],
    `[undo-apply] Done: deleted every api key, with ${keysFile}.`,
  );
  assert.ok(
    host.calls.some(
      (call) =>
        call.kind === "removeRootTree" && call.path === settings.acmeStatePath,
    ),
  );
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

test("a folder that was there keeps its mode and stays", async () => {
  const override = JSON.stringify({ hostname: HOSTNAME });
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
    (call) => call.kind === "makeRootDir" && call.path === credentialFolder,
  );
  assert.deepEqual(remade, []);
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  assert.equal(record.has(`savedPasswordFolder:${credentialFolder}`), false);
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(host.files.has(credentialFolder));
  assert.equal(host.files.has(settings.passwordCredentialPath), false);
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

test("the dry run says each step, and changes nothing", async () => {
  const { host, settings } = await appliedValidator();
  const before = host.calls.length;
  const files = [...host.files.keys()].sort();
  const { code, lines, asked } = await undoApply(host, settings, {
    dryRun: true,
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.ok(
    lines[0].startsWith("[undo-apply] Would ask: Delete every api key?"),
  );
  // The keys' file goes before any step, so no step lists it.
  assert.equal(
    lines[1],
    `[undo-apply] After a yes, it would first delete every api key, with ${hashedApiKeysPathOf(settings, HOME)}. The steps below assume that yes.`,
  );
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
      call.args?.includes("purge") && purgeWorks === false
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
  const nginxFolder = path.dirname(settings.nginxConfigPath);
  host.files.set(`${nginxFolder}/another-tool.conf`, "");
  const certificates = settings.acmeStatePath;
  const moved = { ...settings, acmeStatePath: `${certificates}-moved` };
  const { code, lines } = await undoApply(host, moved);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(
    host.calls.some(
      (call) => call.kind === "removeRootTree" && call.path === certificates,
    ),
    false,
  );
  assert.ok(host.files.has(nginxFolder));
  assert.ok(
    lines.includes(
      `[undo-apply] ${certificates} isn't where the settings now put it, so it stays. Remove it by hand if apply made it.`,
    ),
  );
  assert.ok(
    lines.includes(
      `[undo-apply] ${nginxFolder} holds files apply didn't make, so it stays.`,
    ),
  );
});

test("after apply --acme-staging with every setting changed and the password saved, undo-apply leaves the files as apply found them, using each configured path and never a shipped one", async () => {
  const { shipped, changed } = shippedAndChangedSettings();
  const scenario = { settings: { ...changed, hostname: HOSTNAME } };
  // A fresh fake holds the files as apply finds them.
  const found = fakeX1Validator(scenario).host.files;
  const { host, settings } = await appliedValidator(scenario, {
    acmeStaging: true,
    savePassword: true,
  });
  const from = host.calls.length;
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(lines.at(-1), "[undo-apply] Everything apply did is undone.");
  assert.deepEqual(host.files, found);
  const undoCalls = host.calls.slice(from);
  assert.deepEqual(wrongPaths(undoCalls, shipped, changed, HOME), {
    shippedUsed: [],
    changedUnused: [],
  });
});

test("undo-apply removes every folder apply made for the saved password, however many were missing", async () => {
  const { shipped, changed } = shippedAndChangedSettings();
  // Only the saved password moves, so no other file shares its folders.
  const settings = {
    ...shipped,
    hostname: HOSTNAME,
    passwordCredentialPath: changed.passwordCredentialPath,
  };
  const scenario = { settings };
  const found = fakeX1Validator(scenario).host.files;
  const { host } = await appliedValidator(scenario, { savePassword: true });
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(host.files, found);
});

test("inside a folder only root can look into, undo-apply removes the folder apply made for the saved password, and leaves one that was there", async () => {
  const { shipped } = shippedAndChangedSettings();
  // The shipped folder, which systemd makes at boot, root's alone.
  const store = path.dirname(shipped.passwordCredentialPath);
  const folder = path.join(store, "x1-validator-services");
  const name = path.basename(shipped.passwordCredentialPath);
  const settings = {
    ...shipped,
    hostname: HOSTNAME,
    passwordCredentialPath: path.join(folder, name),
  };
  for (const there of [[store], [store, folder]]) {
    const scenario = {
      settings,
      files: new Map(there.map((each) => [each, ""])),
      state: { rootOnlyFolders: [store] },
    };
    const found = fakeX1Validator(scenario).host.files;
    const { host } = await appliedValidator(scenario, { savePassword: true });
    const { code, lines } = await undoApply(host, settings);
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(host.files, found, there.join(" "));
  }
});

test("a later apply keeps the first one's old values, replaces its own hook and cron lines, and undo-apply removes all it made", async () => {
  const { host, state, settings, scriptPath } = await appliedValidator();
  const hookPath = gitHookPathOf(settings, HOME);
  await host.sleep(1000);
  host.files.set(scriptPath, fixtureScript());
  host.nodePath = () => "/opt/node-v22/bin/node";
  // Another number of hours, so the key count's line changes too.
  const later = {
    ...settings,
    apiKeyCountCheckHours: settings.apiKeyCountCheckHours + 1,
  };
  const again = commandRun(host, later, {
    prompts: scriptedPrompts(),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(again), 0, again.lines.join("\n"));
  const toolLines = state.crontab
    .split("\n")
    .filter((line) => line.includes(" ensure"));
  assert.equal(toolLines.length, 2);
  assert.ok(
    toolLines.every((line) => line.includes("/opt/node-v22/bin/node")),
    state.crontab,
  );
  assert.ok(
    toolLines[1].startsWith(`0 */${later.apiKeyCountCheckHours} `),
    toolLines[1],
  );
  assert.ok(host.files.get(hookPath).includes("/opt/node-v22/bin/node"));
  const { code, lines } = await undoApply(host, settings);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(state.crontab, autopilotCrontab());
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
      call.command === "ufw" && call.args[0] === "delete" && ufwWorks === false
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
  assert.equal(
    first.lines.at(-1),
    `[undo-apply] The steps above that failed or were skipped stay in ${featurePaths().whatApplyChangedPath}. Running undo-apply again retries them.`,
  );
  ufwWorks = true;
  const second = await undoApply(host, settings);
  assert.equal(second.code, 0, second.lines.join("\n"));
  assert.equal(state.ufwRules.includes(HTTPS_RULE), false);
});

test("while another command holds the start script's lock, the flag stays on record, and a second undo-apply takes it out", async () => {
  const { host, settings, scriptPath } = await appliedValidator();
  const release = lockStartScript(host, featurePaths().statePath);
  const first = await undoApply(host, settings);
  release();
  assert.equal(first.code, 1);
  assert.ok(
    first.lines.some((line) => line.endsWith(START_SCRIPT_LOCKED)),
    first.lines.join("\n"),
  );
  assert.match(host.files.get(scriptPath), / --private-rpc \\$/m);
  assert.ok(targetsNamed(host, "privateRpcFlag").includes(scriptPath));
  const second = await undoApply(host, settings);
  assert.equal(second.code, 0, second.lines.join("\n"));
  assert.equal(host.files.get(scriptPath), fixtureScript());
});

test("with nothing recorded, there is nothing to undo", async () => {
  const settings = loadSettings(copyShippedConfig().configDir);
  const { host } = fakeX1Validator({ settings });
  const { code, lines, asked } = await undoApply(host, settings);
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(lines, [
    "[undo-apply] apply hasn't changed anything here, so there is nothing to undo.",
  ]);
});
