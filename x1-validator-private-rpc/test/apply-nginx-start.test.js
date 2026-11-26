/**
 * @file x1-validator-private-rpc/test/apply-nginx-start.test.js
 * @description
 * Tests how a later apply has nginx take up its files, and checks it, on
 * a fake validator that apply set up:
 *
 * - a stopped nginx starts
 * - a running nginx reloads when a file of nginx's changed, so it keeps
 *   answering, after apply makes nginx's log folder again if it's gone
 * - it restarts instead when the drop-in changed, since systemd reads a
 *   start's command only at a start, or when it doesn't answer. With
 *   every setting changed, the drop-in it writes is the one they call for.
 * - an nginx that lets a path without a key, or a random key, through
 *   stops apply
 * - an `nginx -t` that refuses the configuration stops apply before
 *   systemd reads the drop-in, and before any start, restart or reload.
 *   The key check, nginx.conf and the drop-in go back as they were, and
 *   what nginx refused is kept in the tool's error log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runApply } from "../src/cli/apply.js";
import { featurePaths } from "../src/cli/feature-paths.js";
import { GATE_PAGE_PATH } from "../src/lib/gate-page.js";
import {
  NGINX_LOG_DIR,
  NGINX_LOG_DIR_MODE,
  NGINX_UNIT,
} from "../src/lib/nginx-org.js";
import { renderDropIn } from "../src/lib/render-host-files.js";
import { appliedValidator, commandRun } from "./helpers/applied-validator.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { HOSTNAME } from "./helpers/fake-x1-validator.js";
import { scriptedPrompts } from "./helpers/scripted-prompts.js";

/**
 * Lists how a run had systemd start, restart or reload nginx.
 * @param {object[]} calls  The fake host's calls during the run.
 * @returns {string[]} The verbs, in order.
 */
function nginxVerbs(calls) {
  return calls
    .filter(
      (call) =>
        call.kind === "sudo" &&
        call.command === "systemctl" &&
        call.args[1] === NGINX_UNIT &&
        ["start", "restart", "reload"].includes(call.args[0]),
    )
    .map((call) => call.args[0]);
}

/**
 * Runs apply again, and lists how it had systemd start, restart or
 * reload nginx.
 * @param {object} host  The fake host.
 * @param {object} settings  The settings.
 * @returns {Promise<string[]>} The verbs, in order.
 */
async function applyAgain(host, settings) {
  const before = host.calls.length;
  const run = commandRun(host, settings, {
    prompts: scriptedPrompts(),
    options: { yes: false, dryRun: false, acmeStaging: false },
  });
  assert.equal(await runApply(run), 0, run.lines.join("\n"));
  const calls = host.calls.slice(before);
  return nginxVerbs(calls);
}

test("a stopped nginx starts", async () => {
  const { host, state, settings } = await appliedValidator();
  state.active = false;
  assert.deepEqual(await applyAgain(host, settings), ["start"]);
  assert.equal(state.active, true);
});

test("a running nginx reloads when a file of nginx's changed", async () => {
  const { host, settings } = await appliedValidator();
  const { njsModuleSource } = featurePaths();
  host.files.set(njsModuleSource, "export default { changed: true };\n");
  assert.deepEqual(await applyAgain(host, settings), ["reload"]);
});

test("with nginx's log folder gone, apply makes it again, as nginx.org's package makes it, before nginx -t opens the logs", async () => {
  const { host, settings } = await appliedValidator();
  host.files.delete(NGINX_LOG_DIR);
  const { njsModuleSource } = featurePaths();
  host.files.set(njsModuleSource, "export default { changed: true };\n");
  const before = host.calls.length;
  assert.deepEqual(await applyAgain(host, settings), ["reload"]);
  const calls = host.calls.slice(before);
  const made = calls.findIndex(
    (call) => call.kind === "makeRootDir" && call.path === NGINX_LOG_DIR,
  );
  const tested = calls.findIndex(
    (call) => call.command === "nginx" && call.args[0] === "-t",
  );
  assert.ok(made >= 0 && made < tested, `made at ${made}, tested at ${tested}`);
  assert.equal(calls[made].mode, NGINX_LOG_DIR_MODE);
});

test("a running nginx restarts when the drop-in changed, and with every setting changed gets the drop-in they call for", async () => {
  const { changed } = shippedAndChangedSettings();
  const { host, settings } = await appliedValidator({
    settings: { ...changed, hostname: HOSTNAME },
  });
  host.files.set(settings.systemdDropInPath, "[Service]\n# an older one\n");
  assert.deepEqual(await applyAgain(host, settings), ["restart"]);
  assert.equal(
    host.files.get(settings.systemdDropInPath),
    renderDropIn(settings),
  );
});

test("an nginx that lets a path without a key, or a random key, through stops apply", async () => {
  const { host, state, settings } = await appliedValidator();
  state.active = false;
  const tlsGet = host.tlsGet;
  host.tlsGet = async (target) =>
    target.path === GATE_PAGE_PATH
      ? tlsGet(target)
      : { status: 200, body: "ok", certificate: {} };
  await assert.rejects(applyAgain(host, settings), (error) => {
    assert.match(error.message, /^A path without a key got 200, not 403\.$/m);
    assert.match(
      error.message,
      /^A path with a random key got 200, not 403\.$/m,
    );
    return true;
  });
});

test("an nginx -t that refuses the configuration stops apply before systemd reads the drop-in and before any start, restart or reload, puts back the key check, nginx.conf and drop-in as they were, and keeps what it refused in the tool's error log", async () => {
  // The one nginx call to refuse, set once apply has set the fake up.
  let refused = "";
  const { host, settings } = await appliedValidator({
    respond: (call) =>
      call.kind === "sudo" &&
      call.command === "nginx" &&
      call.args.join(" ") === refused
        ? { status: 1, stderr: "nginx: [emerg] unknown directive" }
        : undefined,
  });
  // Files from an earlier version of the tool, which this run writes over.
  const older = new Map([
    [settings.njsModulePath, "// an older key check\n"],
    [settings.nginxConfigPath, "# an older nginx.conf\n"],
    [settings.systemdDropInPath, "[Service]\n# an older drop-in\n"],
  ]);
  for (const [filePath, text] of older) {
    host.files.set(filePath, text);
  }
  // Only a test of the configured nginx.conf is refused.
  refused = `-t -c ${settings.nginxConfigPath}`;
  const before = host.calls.length;
  const { errorLogPath, njsModuleSource } = featurePaths();
  await assert.rejects(applyAgain(host, settings), (error) => {
    assert.match(
      error.message,
      /^nginx refused the configuration: nginx: \[emerg\] unknown directive$/m,
    );
    assert.ok(error.message.includes(errorLogPath), error.message);
    return true;
  });
  const calls = host.calls.slice(before);
  assert.deepEqual(nginxVerbs(calls), []);
  const reloads = calls.filter(
    (call) => call.command === "systemctl" && call.args[0] === "daemon-reload",
  );
  assert.deepEqual(reloads, []);
  for (const [filePath, text] of older) {
    assert.equal(host.files.get(filePath), text, filePath);
  }
  const kept = host.files.get(errorLogPath);
  assert.match(kept, /^nginx said: nginx: \[emerg\] unknown directive$/m);
  assert.ok(kept.includes(`server_name ${settings.hostname};`), kept);
  assert.ok(kept.includes(host.files.get(njsModuleSource)), kept);
});

test("a running nginx that doesn't answer restarts", async () => {
  const { host, settings } = await appliedValidator();
  const tlsGet = host.tlsGet;
  let asked = 0;
  host.tlsGet = async (target) => {
    if (target.path === GATE_PAGE_PATH) {
      asked += 1;
      if (asked === 1) {
        throw new Error("read ECONNRESET");
      }
    }
    return tlsGet(target);
  };
  assert.deepEqual(await applyAgain(host, settings), ["restart"]);
});
