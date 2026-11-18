/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/steps.js
 * @description
 * The upgrade check, step by step. It proves on this machine that a
 * regular apt upgrade of nginx keeps the keyed url working, before the
 * tool is installed. It installs nginx.org's previous release, and
 * starts it under systemd the way the tool will: through the tool's
 * drop-in, with a list holding the hash of a throwaway api key. It
 * checks that the gate page says ok, that a request with the key gets
 * 200, and that one with a random key gets 403. Then it upgrades the
 * packages with apt, which runs the package's own hand-over from the old
 * nginx to the new one, and checks that systemd followed the new process
 * without restarting it, and that the new nginx answers both requests as
 * the old one did. Last, it removes everything it added, even when a
 * step failed, leaving the machine as it found it.
 *
 * Every change is recorded with the step that undoes it, as it's made,
 * and the command that undoes it by hand, which the check prints if its
 * own undo step fails. The undo steps run newest first, so files go
 * before the folders that hold them, folders before the packages that
 * own their parents, and the packages before the repository they came
 * from. A Ctrl-C stops the check after the step it's on, and the undo
 * steps still run. The long apt steps run through `wait`, which shows a
 * spinner on a terminal. Every effect goes through the host it is given,
 * so tests pass a stand-in.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApiKey } from "../../src/lib/api-key.js";
import {
  installedVersion,
  installVersions,
  offeredVersions,
  purgePackages,
} from "../../src/lib/apt.js";
import { mustSucceed } from "../../src/lib/command-result.js";
import { foldersToMake } from "../../src/lib/folders-to-make.js";
import { GATE_PAGE_PATH } from "../../src/lib/gate-page.js";
import { hashApiKey, mapText } from "../../src/lib/key-hash-map.js";
import {
  NGINX_PACKAGES,
  NGINX_UNIT,
  pickUpgradePair,
} from "../../src/lib/nginx-org.js";
import {
  addNginxRepository,
  removeNginxRepository,
} from "../../src/lib/nginx-repo.js";
import { parseOsRelease } from "../../src/lib/os-release.js";
import { pollUntil } from "../../src/lib/poll.js";
import { renderDropIn } from "../../src/lib/render-host-files.js";
import { showUnit, systemctl, systemdVersion } from "../../src/lib/systemd.js";
import { keyProblems, machineProblems, upgradeProblems } from "./judge.js";
import { renderTestNginxConfig } from "./render-test-config.js";

const UNIT_STATE = ["ActiveState", "InvocationID", "MainPID"];

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
 * @property {UndoStep[]} undo  The changes made so far, each with the
 *   step that undoes it.
 */

/**
 * @typedef {object} UndoStep
 * @property {string} what  The step, in words.
 * @property {() => (void|Promise<void>)} action  The step.
 * @property {string} byHand  The shell command that does the same, for
 *   the person at the terminal when the step fails.
 */

/**
 * Stops the check, so the undo steps run, when Ctrl-C was pressed.
 * @param {Context} context  The run.
 * @throws {Error} When Ctrl-C was pressed, since only an error stops the
 *   steps and still runs the undo steps.
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
  const osReleaseText = host.readText("/etc/os-release");
  const osRelease = parseOsRelease(osReleaseText);
  return {
    isRoot: host.isRoot(),
    osRelease,
    codename: osRelease.get("VERSION_CODENAME") ?? "",
    systemdVersion: systemdVersion(host),
    nginxVersion: installedVersion(host, "nginx"),
  };
}

/**
 * Records the removal of a folder about to be created, and of each
 * missing folder above it, since creating it creates them all. They're
 * recorded outermost first, so the undo steps remove them innermost
 * first.
 * @param {Context} context  The run.
 * @param {string} folder  The folder.
 */
function trackNewFolders({ host, undo }, folder) {
  for (const newFolder of foldersToMake(host, folder)) {
    undo.push({
      what: `Removing ${newFolder}`,
      action: () => host.removeRootDir(newFolder),
      byHand: `sudo rmdir ${newFolder}`,
    });
  }
}

/**
 * Writes a file root owns, recording its removal, and the removal of
 * each folder the write creates.
 * @param {Context} context  The run.
 * @param {string} filePath  The file.
 * @param {string} content  Its content.
 * @param {string} mode  Its mode.
 */
function writeTracked(context, filePath, content, mode) {
  const { host, undo } = context;
  trackNewFolders(context, path.dirname(filePath));
  undo.push({
    what: `Removing ${filePath}`,
    action: () => host.removeRootFile(filePath),
    byHand: `sudo rm ${filePath}`,
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
        // nginx's package creates the user. A stop before that leaves none.
        if (hasNginxUser()) {
          const removed = host.sudo("userdel", ["nginx"]);
          mustSucceed(removed, "Removing nginx's user");
        }
      },
      byHand: "sudo userdel nginx",
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
      byHand: `sudo rm ${written.join(" ")} && sudo apt update`,
    });
  }
  stopIfInterrupted(context);
  const pair = pickUpgradePair(offeredVersions(host, NGINX_PACKAGES));
  report("Masking nginx, so the package's default site never starts.");
  systemctl(host, ["mask", NGINX_UNIT]);
  undo.push({
    what: "Unmasking nginx",
    action: () => systemctl(host, ["unmask", NGINX_UNIT]),
    byHand: `sudo systemctl unmask ${NGINX_UNIT}`,
  });
  undo.push({
    what: "Removing nginx and its modules",
    action: () => purgePackages(host, NGINX_PACKAGES),
    byHand: `sudo apt purge ${NGINX_PACKAGES.join(" ")}`,
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
 * Installs the key check, the list with the throwaway key's hash, a
 * test configuration and the drop-in, at the paths the tool itself uses.
 * The key itself exists only in memory.
 * @param {Context} context  The run.
 * @param {number} port  The port on 127.0.0.1 for the test configuration.
 * @param {string} key  The throwaway api key.
 */
function installTestFiles(context, port, key) {
  const { host, settings, report, undo } = context;
  report(
    "Installing four files: a test configuration for nginx, the tool's " +
      "api key check, a list that holds the throwaway key's hash, and a " +
      "systemd drop-in that starts nginx with the test configuration.",
  );
  const njsSource = host.readText(
    shippedFile("src/njs/x1-validator-private-rpc.js"),
  );
  writeTracked(context, settings.njsModulePath, njsSource, "0644");
  const mapPath = settings.hashedApiKeysMapPath;
  const hash = hashApiKey(key);
  const listText = mapText([hash]);
  writeTracked(context, mapPath, listText, "0644");
  const config = renderTestNginxConfig({
    port,
    njsModulePath: settings.njsModulePath,
    mapPath,
  });
  writeTracked(context, settings.nginxConfigPath, config, "0644");
  undo.push({
    what: "Reloading systemd",
    action: () => systemctl(host, ["daemon-reload"]),
    byHand: "sudo systemctl daemon-reload",
  });
  const dropIn = renderDropIn({ nginxConfigPath: settings.nginxConfigPath });
  writeTracked(context, settings.systemdDropInPath, dropIn, "0644");
}

/**
 * Tests the configuration, so a mistake shows nginx's own reason, then
 * starts nginx under systemd, through the tool's drop-in.
 * @param {Context} context  The run.
 */
function startNginx(context) {
  const { host, settings, report, undo } = context;
  const tested = host.sudo("nginx", ["-t", "-c", settings.nginxConfigPath]);
  mustSucceed(tested, "Testing the test configuration");
  report("Starting nginx under systemd, through that drop-in.");
  systemctl(host, ["daemon-reload"]);
  systemctl(host, ["unmask", NGINX_UNIT]);
  undo.push({
    what: "Stopping nginx",
    action: () => systemctl(host, ["stop", NGINX_UNIT]),
    byHand: `sudo systemctl stop ${NGINX_UNIT}`,
  });
  systemctl(host, ["start", NGINX_UNIT]);
}

/**
 * Asks the test nginx for one path, and gives the answer's status.
 * @param {object} host  The host.
 * @param {number} port  The test configuration's port.
 * @param {string} urlPath  The path.
 * @param {number} timeoutMs  How long to wait for an answer.
 * @returns {Promise<number>} The http status, or 0 with no answer.
 */
async function readStatus(host, port, urlPath, timeoutMs) {
  try {
    const response = await host.httpGet(
      `http://127.0.0.1:${port}${urlPath}`,
      timeoutMs,
    );
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * Asks the gate page once.
 * @param {object} host  The host.
 * @param {number} port  The test configuration's port.
 * @param {number} timeoutMs  How long to wait for an answer.
 * @returns {Promise<string>} `ok`, or what came instead.
 */
async function readGate(host, port, timeoutMs) {
  try {
    const response = await host.httpGet(
      `http://127.0.0.1:${port}${GATE_PAGE_PATH}`,
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
    intervalMs: settings.upgradeCheckPollMs,
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
 * Waits for the gate page to say ok, then asks for a path with the
 * throwaway key and one with a random key.
 * @param {Context} context  The run.
 * @param {number} port  The test configuration's port.
 * @param {string} key  The throwaway api key.
 * @returns {Promise<{gate: string, keyed: number, stranger: number}>}
 *   The gate page's last answer, and the two answers' statuses.
 */
async function askWithKeys(context, port, key) {
  const { host } = context;
  const { timeoutMs } = timing(context);
  const { answer: gate } = await pollUntil(
    () => readGate(host, port, timeoutMs),
    (answer) => answer === "ok",
    timing(context),
  );
  const keyed = await readStatus(host, port, `/${key}/`, timeoutMs);
  const randomKey = makeApiKey();
  const stranger = await readStatus(host, port, `/${randomKey}/`, timeoutMs);
  return { gate, keyed, stranger };
}

/**
 * Upgrades the packages, waits for the hand-over to finish, and gathers
 * what the verdict needs.
 *
 * The hand-over is done once systemd follows the new main process, or
 * stops counting nginx as active, and the old main process has exited.
 * Until then the old nginx's workers are shutting down, and one of them
 * may accept a request and close it unanswered, so nginx is asked only
 * after that, and given the time limit for its gate page to say ok.
 * @param {Context} context  The run.
 * @param {number} port  The test configuration's port.
 * @param {object[]} newest  The package set to upgrade to.
 * @param {string} key  The throwaway api key.
 * @returns {Promise<object>} What upgradeProblems judges.
 */
async function upgradeAndObserve(context, port, newest, key) {
  const { host } = context;
  const before = showUnit(host, NGINX_UNIT, UNIT_STATE);
  const oldMain = `/proc/${before.get("MainPID")}`;
  await longStep(
    context,
    `Upgrading to nginx ${newest[0].version} from nginx.org with apt. ` +
      "This might take a few minutes.",
    () => installVersions(host, newest),
  );
  const { answer: after } = await pollUntil(
    async () => showUnit(host, NGINX_UNIT, UNIT_STATE),
    (state) =>
      state.get("MainPID") !== before.get("MainPID") ||
      state.get("ActiveState") !== "active",
    timing(context),
  );
  const { wanted: oldMainGone } = await pollUntil(
    async () => host.exists(oldMain),
    (running) => running === false,
    timing(context),
  );
  return {
    before,
    after,
    programAfter: processProgram(host, after.get("MainPID") ?? "0"),
    oldMainRunning: oldMainGone === false,
    answersAfter: await askWithKeys(context, port, key),
    installedVersion: installedVersion(host, "nginx"),
    expectedVersion: newest[0].version,
  };
}

/**
 * Runs the steps, recording each change's undo step as it goes.
 * @param {Context} context  The run.
 * @returns {Promise<string[]>} What failed, or nothing when the check
 *   passed.
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
  const asked = host.sudo("true", []);
  mustSucceed(asked, "Getting sudo");
  stopIfInterrupted(context);
  const pair = await installPreviousRelease(context, facts.codename);
  stopIfInterrupted(context);
  const port = await host.freeLoopbackPort();
  const key = makeApiKey();
  installTestFiles(context, port, key);
  stopIfInterrupted(context);
  startNginx(context);
  const answers = await askWithKeys(context, port, key);
  stopIfInterrupted(context);
  const before = keyProblems(answers, "Before the upgrade");
  if (before.length > 0) {
    return before;
  }
  const observed = await upgradeAndObserve(context, port, pair.newest, key);
  return upgradeProblems(observed);
}

/**
 * Runs every undo step, newest first, going on past any that fails.
 * @param {Context} context  The run.
 * @returns {Promise<string[]>} One message per undo step that failed,
 *   with a second line giving the command that does it by hand.
 */
async function undoAll({ undo }) {
  const failures = [];
  for (const step of [...undo].reverse()) {
    try {
      await step.action();
    } catch (error) {
      failures.push(
        `Couldn't finish "${step.what}": ${error.message}\n` +
          `  By hand: ${step.byHand}`,
      );
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
 * @param {Context["wait"]} [options.wait]  Runs a long step. Without a
 *   spinner, it prints the step's line and runs it.
 * @param {() => boolean} [options.isInterrupted]  Whether Ctrl-C was
 *   pressed, which is never unless the caller watches for it.
 * @returns {Promise<{passed: boolean, problems: string[],
 *   leftovers: string[]}>} The verdict, what failed in the check, and
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
