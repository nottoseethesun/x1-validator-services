/**
 * @file x1-validator-private-rpc/src/cli/apply-watchers.js
 * @description
 * apply's sixth and seventh stages. The sixth adds `--private-rpc` to
 * x1console's start script, after saving a timestamped backup beside it,
 * which x1console's `git stash` leaves alone, and keeps the script's
 * mode. The validator takes the flag at its next start.
 *
 * The seventh installs what keeps the flag in place: the tool's git hook
 * in x1console's checkout, which runs ensure after an Update X1 Console
 * pulls new commits, and, when the operator agrees, two cron jobs: one
 * runs ensure every minute, the other checks every apiKeyCountCheckHours
 * hours that nginx holds an api key. It makes the two folders the cron
 * lines write in, which git doesn't track, and records them, so
 * undo-apply removes them. Each line also makes its folders whenever
 * they're missing, so deleting one stops no run. The cron lines go in the
 * way Autopilot adds its own: the whole table is read, the lines added,
 * and the table written back, so Autopilot's jobs stay. Another
 * program's git hook stays as it is, and the cron job covers for it.
 * Last, it sends a test alert when x1console's Telegram files are there.
 *
 * A later apply may find its own hook or cron lines from an earlier run.
 * When the tool's hook names an old path to Node.js or to the tool, it
 * writes the hook again: it knows its hook by the whole text, which only
 * those two paths change. It replaces any cron line an earlier apply
 * installed, which it knows from its record, that this version writes
 * differently, without asking. Each backup copy and cron line it makes
 * has an entry of its own in the record, so undo-apply removes every one.
 */

import path from "node:path";
import { gitHookPathOf } from "./feature-paths.js";
import {
  isToolHook,
  renderCronLine,
  renderGitHook,
  renderKeyCountCronLine,
} from "./render-watchers.js";
import { addPrivateRpc } from "./start-script.js";
import { readTelegram, sendTelegram } from "./telegram.js";
import { found, made, partsOf } from "./what-apply-changed.js";

/**
 * Writes a time as the backup's stamp, YYYYMMDD-HHMMSS, in UTC.
 * @param {number} ms  The time, in milliseconds since 1970.
 * @returns {string}
 */
export function backupStamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/**
 * Runs the sixth stage.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
export async function editStartScript(context) {
  const { host, facts, record, change, log } = context;
  const scriptPath = facts.startScriptPath;
  const flagKey = `privateRpcFlag:${scriptPath}`;
  const original = host.readText(scriptPath);
  const { text, changed } = addPrivateRpc(original, scriptPath);
  if (changed === false) {
    log.info(
      "start script",
      "The validator's command carries --private-rpc already.",
    );
    record(found(flagKey));
    return;
  }
  const now = host.now();
  const backup = `${scriptPath}.bak-${backupStamp(now)}`;
  await change(
    "start script",
    `add --private-rpc to ${scriptPath}, after saving ${backup}`,
    () => {
      const mode = host.fileMode(scriptPath);
      host.writeUserFile(backup, original, mode);
      record(made(`startScriptBackup:${backup}`));
      host.writeUserFile(scriptPath, text, mode);
      record(made(flagKey));
    },
  );
}

/**
 * Installs the tool's git hook in x1console's checkout, or
 * replaces the one an earlier apply wrote, unless another program's hook
 * is there.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function installHook(context) {
  const { host, settings, paths, record, change, log } = context;
  const homeDir = host.homeDir();
  const hookPath = gitHookPathOf(settings, homeDir);
  const hooks = path.dirname(hookPath);
  const key = `gitHook:${hookPath}`;
  const nodeBin = host.nodePath();
  const hook = renderGitHook({ nodeBin, toolCli: paths.toolCli });
  if (!host.exists(hooks)) {
    log.problem(
      "watchers",
      `${hooks} is missing, so there is no git hook. The cron job covers for it.`,
    );
    return;
  }
  const present = host.exists(hookPath) ? host.readText(hookPath) : null;
  if (present === hook) {
    record(found(key));
    return;
  }
  if (present !== undefined && present !== null && !isToolHook(present)) {
    log.problem(
      "watchers",
      `${hookPath} is another program's hook, so it stays. The cron job covers for it.`,
    );
    return;
  }
  await change("watchers", `write ${hookPath}`, () => {
    host.writeUserFile(hookPath, hook, 0o755);
    record(made(key));
  });
}

/**
 * Installs the two cron lines, when the operator agrees and they aren't
 * there yet. Any line an earlier apply installed that this version
 * writes differently is replaced without asking again, since the
 * operator agreed to the jobs then.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function installCronLines(context) {
  const { host, settings, paths, whatApplyChanged, record, change } = context;
  const { prompts, log } = context;
  const nodeBin = host.nodePath();
  const lines = [
    renderCronLine({
      nodeBin,
      toolCli: paths.toolCli,
      lockPath: paths.lockPath,
      logPath: paths.ensureLogPath,
    }),
    renderKeyCountCronLine({
      nodeBin,
      toolCli: paths.toolCli,
      logPath: paths.ensureLogPath,
      hours: settings.apiKeyCountCheckHours,
    }),
  ];
  const listed = host.run("crontab", ["-l"]);
  const table = listed.status === 0 ? listed.stdout : "";
  const entries = table.split("\n");
  if (lines.every((line) => entries.includes(line))) {
    log.info("watchers", "The cron jobs are installed already.");
    for (const line of lines) {
      record(found(`cronLine:${line}`));
    }
    return;
  }
  const ours = [...whatApplyChanged.keys()]
    .map((recorded) => partsOf(recorded))
    .filter(({ name }) => name === "cronLine")
    .map(({ target }) => target);
  const kept = entries.filter(
    (entry) => !ours.includes(entry) && !lines.includes(entry),
  );
  const replacing = entries.some((entry) => ours.includes(entry));
  const wanted =
    context.dryRun === true ||
    replacing === true ||
    (await prompts.confirm(
      "One cron job would run ensure every minute: ensure puts " +
        "--private-rpc back after an x1console update takes it out, and " +
        "sends the tool's alerts. The other would check every " +
        `${settings.apiKeyCountCheckHours} hours that nginx holds an api ` +
        "key. Install them?",
    ));
  if (wanted === false) {
    log.info(
      "watchers",
      "No cron jobs: nothing runs ensure every minute, or checks every " +
        `${settings.apiKeyCountCheckHours} hours that nginx holds an api ` +
        "key, so no alert goes out on a schedule. After each Update X1 " +
        `Console, wait ${settings.startScriptQuietSeconds} seconds, then ` +
        "run ensure yourself, which puts --private-rpc back into the start " +
        "script.",
    );
    return;
  }
  const folders = new Map([
    ["toolTmpFolder", paths.tmpDir],
    ["toolLogsFolder", paths.logsDir],
  ]);
  for (const [name, folder] of folders) {
    const folderKey = `${name}:${folder}`;
    if (host.exists(folder)) {
      record(found(folderKey));
    } else {
      await change("watchers", `make ${folder}`, () => {
        host.makeUserDir(folder, 0o755);
        record(made(folderKey));
      });
    }
  }
  const rest = kept.join("\n");
  const separator = rest === "" || rest.endsWith("\n") ? "" : "\n";
  const what =
    replacing === true
      ? "replace the tool's lines in the crontab"
      : "add the tool's two lines to the crontab";
  await change("watchers", what, () => {
    const written = host.run("crontab", ["-"], {
      input: `${rest}${separator}${lines.join("\n")}\n`,
    });
    if (written.status !== 0) {
      throw new Error(
        `crontab refused the new table: ${written.stderr.trim()}`,
      );
    }
    for (const line of lines) {
      const key = `cronLine:${line}`;
      record(entries.includes(line) ? found(key) : made(key));
    }
  });
}

/**
 * Runs the seventh stage.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
export async function installWatchers(context) {
  const { host, settings, change, log } = context;
  await installHook(context);
  await installCronLines(context);
  const telegram = readTelegram(host, settings);
  if (telegram === undefined || telegram === null) {
    log.info(
      "watchers",
      "x1console's Telegram files are missing, so alerts are off, and ensure only logs.",
    );
    return;
  }
  log.hide(telegram.token);
  await change("watchers", "send a test alert on Telegram", () =>
    sendTelegram(
      host,
      telegram,
      `x1-validator-private-rpc on ${settings.hostname}: a test alert from apply. Alerts work.`,
      settings.requestTimeoutSeconds * 1000,
    ),
  );
}
