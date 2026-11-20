/**
 * @file x1-validator-private-rpc/test/apply-fails-part-way.test.js
 * @description
 * Tests apply's record when apply fails part way, and undo-apply after
 * it, on a fake validator. apply records each change of its nginx stage
 * just before making it. So a run that dies during apt's install, or
 * fails while writing nginx.org's repository files, leaves every change
 * on record. After a run that failed at either point, or while waiting
 * for the certificate, undo-apply leaves the machine as apply found it,
 * once the operator has purged the nginx it leaves, and skips a package
 * on record that apt never installed. On a first install, a
 * configuration nginx -t refuses leaves none of the files the run wrote
 * for nginx, is kept in the tool's error log, and once the operator
 * purges nginx, undo-apply takes all back.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import { NGINX_GONE_ALREADY, runUndoApply } from "../src/cli/undo-apply.js";
import { partsOf, readRecord } from "../src/cli/what-apply-changed.js";
import { GATE_PAGE_PATH } from "../src/lib/gate-page.js";
import { NGINX_APT_PIN_PATH } from "../src/lib/nginx-org.js";
import { loadSettings } from "../src/lib/settings.js";
import {
  commandRun,
  PASSWORD,
  purgeNginxByHand,
} from "./helpers/applied-validator.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { fakeX1Validator, HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Builds a fake validator, and the settings apply runs with there.
 * @param {object} [scenario]  The fake's scenario.
 * @returns {{host: object, state: object, settings: object}}
 */
function freshValidator(scenario = {}) {
  const override = JSON.stringify({ hostname: HOSTNAME });
  const settings = loadSettings(copyShippedConfig(override).configDir);
  const { host, state } = fakeX1Validator({ ...scenario, settings });
  return { host, state, settings };
}

/**
 * Reads what a test compares: the fake's files, and the parts of its
 * state that apply changes.
 * @param {object} host  The fake host.
 * @param {object} state  The fake's state.
 * @returns {object}
 */
function machineOf(host, state) {
  return {
    files: [...host.files.keys()].sort(),
    nginx: [
      state.nginxInstalled,
      state.nginxUser,
      state.masked,
      state.enabled,
      state.active,
    ],
    ufwRules: [...state.ufwRules],
    crontab: state.crontab,
  };
}

/**
 * Runs apply, which must fail, then undo-apply, which must leave the
 * machine as apply found it. When apply got as far as installing nginx,
 * undo-apply leaves it, so the operator's purge of nginx, and a second
 * undo-apply, come first.
 * @param {{host: object, state: object, settings: object}} validator
 *   The fake validator.
 * @param {string} failure  Part of the message apply must fail with.
 * @param {() => void} [between]  Checks the machine once apply stopped,
 *   before undo-apply runs.
 * @returns {Promise<{names: string[], lines: string[]}>} The names in
 *   apply's record once it stopped, oldest first, and what undo-apply
 *   printed.
 */
async function failThenUndo(
  { host, state, settings },
  failure,
  between = () => {},
) {
  const before = machineOf(host, state);
  const applying = commandRun(host, settings, {
    prompts: scriptedPrompts({ passwords: [PASSWORD, PASSWORD] }),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  await assert.rejects(runApply(applying), (error) =>
    error.message.includes(failure),
  );
  const record = readRecord(host, featurePaths().whatApplyChangedPath);
  const names = [...record.keys()].map((key) => partsOf(key).name);
  between();
  const undo = async () => {
    const undoing = commandRun(host, settings, {
      prompts: scriptedPrompts({ ask: () => true }),
    });
    assert.equal(await runUndoApply(undoing), 0, undoing.lines.join("\n"));
    return undoing.lines;
  };
  const lines = await undo();
  if (state.nginxInstalled === true) {
    await purgeNginxByHand(host);
    lines.push(...(await undo()));
  }
  assert.deepEqual(machineOf(host, state), before);
  return { names, lines };
}

test("on a first install, a configuration nginx -t refuses leaves none of the files the run wrote for nginx, is kept in the tool's error log, and once the operator purges nginx, undo-apply leaves the machine as apply found it", async () => {
  // The one nginx call to refuse, set once the fake's settings are known.
  let refused = "";
  const validator = freshValidator({
    respond: (call) =>
      call.kind === "sudo" &&
      call.command === "nginx" &&
      call.args.join(" ") === refused
        ? { status: 1, stderr: "nginx: [emerg] unknown directive" }
        : undefined,
  });
  const { host, settings } = validator;
  // Only a test of the configured nginx.conf is refused.
  refused = `-t -c ${settings.nginxConfigPath}`;
  const { errorLogPath } = featurePaths();
  const { names } = await failThenUndo(
    validator,
    "nginx refused the configuration",
    () => {
      const written = [
        settings.njsModulePath,
        settings.nginxConfigPath,
        settings.systemdDropInPath,
      ];
      for (const filePath of written) {
        assert.equal(host.files.has(filePath), false, filePath);
      }
      assert.match(
        host.files.get(errorLogPath),
        /^nginx said: nginx: \[emerg\] unknown directive$/m,
      );
    },
  );
  // The tool's logs folder, made for the error log, is on record.
  assert.ok(names.includes("toolLogsFolder"), names.join(", "));
});

test("a run that dies during apt's install of nginx leaves it on record, and undo-apply keeps it there until the operator purges nginx", async () => {
  const validator = freshValidator({
    respond: (call, state) => {
      if (call.command !== "env" || !call.args.includes("install")) {
        return undefined;
      }
      // apt installed nginx, then the run died before apt was done.
      Object.assign(state, { nginxInstalled: true, nginxUser: true });
      return { status: 130, stderr: "Interrupted" };
    },
  });
  const { names } = await failThenUndo(validator, "Installing nginx");
  assert.deepEqual(names, [
    "nginxServiceMasked",
    "nginxAptKeyring",
    "nginxAptSource",
    "nginxAptPin",
    "nginxAccount",
    "nginxPackage",
    "nginxPackage",
    "nginxPackage",
  ]);
});

test("a repository file is on record from just before it's written, so one whose write fails is there too", async () => {
  const validator = freshValidator();
  const { host } = validator;
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, ...rest) => {
    if (filePath === NGINX_APT_PIN_PATH) {
      throw new Error("No space left on device");
    }
    return writeRootFile(filePath, ...rest);
  };
  const { names } = await failThenUndo(validator, "No space left on device");
  assert.deepEqual(names, [
    "nginxServiceMasked",
    "nginxAptKeyring",
    "nginxAptSource",
    "nginxAptPin",
  ]);
});

test("after a run that waited in vain for the certificate, and once the operator purges nginx, undo-apply leaves the machine as apply found it", async () => {
  const validator = freshValidator();
  const { host } = validator;
  const tlsGet = host.tlsGet;
  host.tlsGet = async (target) =>
    target.path === GATE_PAGE_PATH
      ? { status: 503, body: "", certificate: {} }
      : tlsGet(target);
  const { names } = await failThenUndo(validator, "No certificate in time");
  assert.ok(
    names.includes("nginxConfigFile") && names.includes("nginxServiceEnabled"),
    names.join(", "),
  );
});

test("packages on record that apt never installed are skipped by undo-apply", async () => {
  const validator = freshValidator({
    respond: (call) =>
      call.command === "env" && call.args.includes("install")
        ? { status: 100, stderr: "E: Unable to fetch some archives" }
        : undefined,
  });
  const { lines } = await failThenUndo(validator, "Installing nginx");
  assert.ok(
    lines.includes(`[undo-apply] ${NGINX_GONE_ALREADY}`),
    lines.join("\n"),
  );
});
