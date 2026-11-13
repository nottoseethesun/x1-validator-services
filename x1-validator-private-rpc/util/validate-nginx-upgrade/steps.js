/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/steps.js
 * @description
 * The upgrade check, step by step. It proves on this machine that a
 * regular apt upgrade of nginx keeps the gated rpc working, before the
 * tool is installed. It installs nginx.org's previous release, starts it
 * under systemd the way the tool will (through the start wrapper, with
 * an api key handed over in the memory-only file), and checks that the
 * gate page says unlocked. Then it upgrades the packages with apt, which
 * runs the package's own hand-over from the old nginx to the new one,
 * and checks that systemd followed the new process without restarting
 * it and that the key carried over. Last, it removes everything it
 * added, even when a step failed, leaving the machine as it found it.
 *
 * Every change is recorded with the step that undoes it, as it's made.
 * The undo steps run newest first, so files go before the packages that
 * own their folders, and the packages before the repository they came
 * from. A Ctrl-C stops the check after the step it's on, and the undo
 * steps still run. The long apt steps run through `wait`, which shows a
 * spinner on a terminal. Every effect goes through the host it is given,
 * so tests pass a stand-in.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installedVersion,
  installVersions,
  offeredVersions,
  purgePackages,
} from "../../src/lib/apt.js";
import { mustSucceed } from "../../src/lib/command-result.js";
import { NGINX_PACKAGES, pickUpgradePair } from "../../src/lib/nginx-org.js";
import {
  addNginxRepository,
  removeNginxRepository,
} from "../../src/lib/nginx-repo.js";
import { parseOsRelease } from "../../src/lib/os-release.js";
import { pollUntil } from "../../src/lib/poll.js";
import {
  renderDropIn,
  renderStartWrapper,
} from "../../src/lib/render-host-files.js";
import { showUnit, systemctl, systemdVersion } from "../../src/lib/systemd.js";
import { machineProblems, upgradeProblems } from "./judge.js";
import { renderTestNginxConfig } from "./render-test-config.js";

const UNIT = "nginx.service";
const UNIT_STATE = ["ActiveState", "InvocationID", "MainPID"];

/** The pause between two questions to nginx or systemd. */
const POLL_INTERVAL_MS = 250;

/** What the check reports when Ctrl-C stopped it. */
const STOPPED = "Stopped because Ctrl-C was pressed.";

/**
 * @typedef {object} Context
 * @property {object} host  The host.
 * @property {object} settings  The tool's settings.
 * @property {(line: string) => void} report  Prints one progress line.
 * @property {(line: string, work: () => Promise<*>) => Promise<*>} wait
 *   Prints the progress line of a long step and runs the step, showing
 *   that it's still at work.
 * @property {() => boolean} isInterrupted  Whether Ctrl-C was pressed.
 * @property {{what: string, action: () => (void|Promise<void>)}[]} undo
 *   The changes made so far, each with the step that undoes it.
 */

/**
 * Stops the check, so the undo steps run, when Ctrl-C was pressed.
 * @param {Context} context  The run.
 * @throws {Error} When Ctrl-C was pressed.
 */
function stopIfInterrupted(context) {
  if (context.isInterrupted()) {
    throw new Error(STOPPED);
  }
}

/**
 * Runs a long step through `wait`. It renews sudo first, so sudo never
 * asks for the password while the spinner holds the terminal.
 * @param {Context} context  The run.
 * @param {string} line  The step's progress line.
 * @param {() => Promise<*>} work  The step.
 * @returns {Promise<*>} What the step returns.
 */
function longStep(context, line, work) {
  context.host.sudo("true", []);
  return context.wait(line, work);
}

/**
 * Finds a file the tool ships, from this file's own location.
 * @param {string} relative  The file, relative to the feature's folder.
 * @returns {string} Its absolute path.
 */
function shippedFile(relative) {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

/**
 * Reads what the check needs to know about the machine.
 * @param {object} host  The host.
 * @returns {object} The facts machineProblems judges, and the release's
 *   code name.
 */
function readMachine(host) {
  const osRelease = parseOsRelease(host.readText("/etc/os-release"));
  return {
    isRoot: host.isRoot(),
    osRelease,
    codename: osRelease.get("VERSION_CODENAME") ?? "",
    systemdVersion: systemdVersion(host),
    nginxVersion: installedVersion(host, "nginx"),
  };
}

/**
 * Writes a file root owns, recording its removal, and the removal of its
 * folder when the folder is new.
 * @param {Context} context  The run.
 * @param {string} filePath  The file.
 * @param {string} content  Its content.
 * @param {string} mode  Its mode.
 */
function writeTracked({ host, undo }, filePath, content, mode) {
  const folder = path.dirname(filePath);
  if (!host.exists(folder)) {
    undo.push({
      what: `Removing ${folder}`,
      action: () => host.removeRootDir(folder),
    });
  }
  undo.push({
    what: `Removing ${filePath}`,
    action: () => host.removeRootFile(filePath),
  });
  host.writeRootFile(filePath, content, mode);
}

/**
 * Adds nginx.org's repository, masks nginx so the package's default site
 * never starts, and installs the previous release.
 * @param {Context} context  The run.
 * @param {string} codename  The Ubuntu release's code name.
 * @returns {Promise<{previous: object[], newest: object[]}>} The two
 *   package sets.
 */
async function installPreviousRelease(context, codename) {
  const { host, settings, report, undo } = context;
  const hasNginxUser = () =>
    host.run("getent", ["passwd", "nginx"]).status === 0;
  if (!hasNginxUser()) {
    undo.push({
      what: "Removing the nginx user",
      action: () => {
        // nginx's package creates the user; a stop before that leaves none.
        if (hasNginxUser()) {
          mustSucceed(host.sudo("userdel", ["nginx"]), "Removing nginx's user");
        }
      },
    });
  }
  const written = await longStep(
    context,
    "Adding nginx.org's apt repository.",
    () =>
      addNginxRepository(host, {
        codename,
        timeoutMs: settings.requestTimeoutSeconds * 1000,
      }),
  );
  if (written.length > 0) {
    undo.push({
      what: "Removing nginx.org's apt repository",
      action: () => removeNginxRepository(host, written),
    });
  }
  stopIfInterrupted(context);
  const pair = pickUpgradePair(offeredVersions(host, NGINX_PACKAGES));
  report("Masking nginx, so the package's default site never starts.");
  systemctl(host, ["mask", UNIT]);
  undo.push({
    what: "Unmasking nginx",
    action: () => systemctl(host, ["unmask", UNIT]),
  });
  undo.push({
    what: "Removing nginx and its modules",
    action: () => purgePackages(host, NGINX_PACKAGES),
  });
  await longStep(
    context,
    `Installing nginx ${pair.previous[0].version} and its modules from ` +
      "nginx.org. This might take a few minutes.",
    () => installVersions(host, pair.previous),
  );
  return pair;
}

/**
 * Installs the key check, a test configuration, the start wrapper and
 * the drop-in, at the paths the tool itself uses.
 * @param {Context} context  The run.
 * @param {number} port  The port on 127.0.0.1 for the test configuration.
 */
function installTestFiles(context, port) {
  const { host, settings, report, undo } = context;
  report("Installing the key check, the start wrapper and the drop-in.");
  const njsSource = host.readText(
    shippedFile("src/njs/x1-validator-private-rpc.js"),
  );
  writeTracked(context, settings.njsModulePath, njsSource, "0644");
  writeTracked(
    context,
    settings.nginxConfigPath,
    renderTestNginxConfig({ port, njsModulePath: settings.njsModulePath }),
    "0644",
  );
  const wrapper = renderStartWrapper({
    validatorUser: host.userName(),
    nodeBin: host.nodePath(),
    toolCli: shippedFile("src/cli.js"),
    nginxConfigPath: settings.nginxConfigPath,
    keyHandOffPath: settings.keyHandOffPath,
  });
  writeTracked(context, settings.startWrapperPath, wrapper, "0755");
  undo.push({
    what: "Reloading systemd",
    action: () => systemctl(host, ["daemon-reload"]),
  });
  const dropIn = renderDropIn({
    startWrapperPath: settings.startWrapperPath,
    passwordCredentialPath: null,
  });
  writeTracked(context, settings.systemdDropInPath, dropIn, "0644");
}

/**
 * Hands nginx a random test key the way `unlock` will, then starts nginx
 * under systemd. The key exists only in memory and in the memory-only
 * hand-off file, which the start wrapper deletes.
 * @param {Context} context  The run.
 */
function startNginx(context) {
  const { host, settings, report, undo } = context;
  const folder = path.dirname(settings.keyHandOffPath);
  if (!host.exists(folder)) {
    undo.push({
      what: `Removing ${folder}`,
      action: () => host.removeRootDir(folder),
    });
    host.makeRootDir(folder, "0700");
  }
  writeTracked(
    context,
    settings.keyHandOffPath,
    crypto.randomBytes(32).toString("hex"),
    "0600",
  );
  report("Starting nginx under systemd, through the start wrapper.");
  systemctl(host, ["daemon-reload"]);
  systemctl(host, ["unmask", UNIT]);
  undo.push({
    what: "Stopping nginx",
    action: () => systemctl(host, ["stop", UNIT]),
  });
  systemctl(host, ["start", UNIT]);
}

/**
 * Asks the gate page once.
 * @param {object} host  The host.
 * @param {number} port  The test configuration's port.
 * @param {number} timeoutMs  How long to wait for an answer.
 * @returns {Promise<string>} `unlocked`, `locked`, or what came instead.
 */
async function readGate(host, port, timeoutMs) {
  try {
    const response = await host.httpGet(
      `http://127.0.0.1:${port}/x1-rpc-gate`,
      timeoutMs,
    );
    return response.status === 200
      ? response.body.trim()
      : `http ${response.status}`;
  } catch (error) {
    return `no answer (${error.message})`;
  }
}

/**
 * Builds the timing for waiting on nginx or systemd.
 * @param {Context} context  The run.
 * @returns {object} pollUntil's timing.
 */
function timing({ host, settings }) {
  return {
    timeoutMs: settings.requestTimeoutSeconds * 1000,
    intervalMs: POLL_INTERVAL_MS,
    now: host.now,
    sleep: host.sleep,
  };
}

/**
 * Reads which program a process runs. The main process belongs to root,
 * so this needs sudo.
 * @param {object} host  The host.
 * @param {string} pid  The process id.
 * @returns {string} Such as `/usr/sbin/nginx`, with ` (deleted)` added
 *   when the program file was replaced since it started.
 */
function processProgram(host, pid) {
  const result = host.sudo("readlink", ["--", `/proc/${pid}/exe`]);
  return result.status === 0 ? result.stdout.trim() : "(no process)";
}

/**
 * Waits for the gate page to say unlocked, or for the time to run out.
 * @param {Context} context  The run.
 * @param {number} port  The test configuration's port.
 * @returns {Promise<string>} The gate page's last answer.
 */
async function waitForUnlocked(context, port) {
  const { answer } = await pollUntil(
    () => readGate(context.host, port, timing(context).timeoutMs),
    (gate) => gate === "unlocked",
    timing(context),
  );
  return answer;
}

/**
 * Upgrades the packages, waits for the hand-over to finish, and gathers
 * what the verdict needs.
 *
 * The hand-over is done once systemd follows the new main process, or
 * stops counting nginx as active, and the old main process has exited.
 * Until then the old nginx's workers are shutting down, and one of them
 * may accept a request and close it unanswered, so the gate page is read
 * only after that, and given the time limit to say unlocked.
 * @param {Context} context  The run.
 * @param {number} port  The test configuration's port.
 * @param {object[]} newest  The package set to upgrade to.
 * @returns {Promise<object>} What upgradeProblems judges.
 */
async function upgradeAndObserve(context, port, newest) {
  const { host } = context;
  const before = showUnit(host, UNIT, UNIT_STATE);
  const oldMain = `/proc/${before.get("MainPID")}`;
  await longStep(
    context,
    `Upgrading to nginx ${newest[0].version} from nginx.org with apt. ` +
      "This might take a few minutes.",
    () => installVersions(host, newest),
  );
  const { answer: after } = await pollUntil(
    async () => showUnit(host, UNIT, UNIT_STATE),
    (state) =>
      state.get("MainPID") !== before.get("MainPID") ||
      state.get("ActiveState") !== "active",
    timing(context),
  );
  const { wanted: oldMainGone } = await pollUntil(
    async () => host.exists(oldMain),
    (running) => !running,
    timing(context),
  );
  return {
    before,
    after,
    programAfter: processProgram(host, after.get("MainPID") ?? "0"),
    oldMainRunning: !oldMainGone,
    gateAfter: await waitForUnlocked(context, port),
    installedVersion: installedVersion(host, "nginx"),
    expectedVersion: newest[0].version,
  };
}

/**
 * Runs the steps, recording each change's undo step as it goes.
 * @param {Context} context  The run.
 * @returns {Promise<string[]>} What failed; nothing when the check passed.
 */
async function runSteps(context) {
  const { host, report } = context;
  report("Checking that this machine can run the check.");
  const facts = readMachine(host);
  const refusals = machineProblems(facts);
  if (refusals.length > 0) {
    return refusals;
  }
  report("Asking for sudo, which the next steps need.");
  mustSucceed(host.sudo("true", []), "Getting sudo");
  stopIfInterrupted(context);
  const pair = await installPreviousRelease(context, facts.codename);
  stopIfInterrupted(context);
  const port = await host.freeLoopbackPort();
  installTestFiles(context, port);
  stopIfInterrupted(context);
  startNginx(context);
  const gate = await waitForUnlocked(context, port);
  stopIfInterrupted(context);
  if (gate === "locked") {
    return [
      "Before the upgrade the gate page says locked, so nginx never got " +
        "the api key.",
    ];
  }
  if (gate !== "unlocked") {
    return [
      "Before the upgrade the gate page never said unlocked; its last " +
        `answer was ${gate}.`,
    ];
  }
  return upgradeProblems(await upgradeAndObserve(context, port, pair.newest));
}

/**
 * Runs every undo step, newest first, going on past any that fails.
 * @param {Context} context  The run.
 * @returns {Promise<string[]>} One message per undo step that failed.
 */
async function undoAll({ undo }) {
  const failures = [];
  for (const step of [...undo].reverse()) {
    try {
      await step.action();
    } catch (error) {
      failures.push(`Couldn't finish "${step.what}": ${error.message}`);
    }
  }
  return failures;
}

/**
 * Runs the whole check.
 * @param {object} options  How to run it.
 * @param {object} options.host  The host.
 * @param {object} options.settings  The tool's settings.
 * @param {(line: string) => void} options.report  Prints a progress line.
 * @param {Context["wait"]} [options.wait]  Runs a long step; without a
 *   spinner, it prints the step's line and runs it.
 * @param {() => boolean} [options.isInterrupted]  Whether Ctrl-C was
 *   pressed; never, unless the caller watches for it.
 * @returns {Promise<{passed: boolean, problems: string[],
 *   leftovers: string[]}>} The verdict; what failed in the check; and
 *   what the clean-up couldn't remove.
 */
export async function validateNginxUpgrade({
  host,
  settings,
  report,
  wait = async (line, work) => {
    report(line);
    return work();
  },
  isInterrupted = () => false,
}) {
  const context = { host, settings, report, wait, isInterrupted, undo: [] };
  let problems;
  try {
    problems = await runSteps(context);
  } catch (error) {
    problems = [isInterrupted() ? STOPPED : error.message];
  }
  const leftovers =
    context.undo.length === 0
      ? []
      : await longStep(context, "Removing everything the check added.", () =>
          undoAll(context),
        );
  return {
    passed: problems.length === 0 && leftovers.length === 0,
    problems,
    leftovers,
  };
}
