/**
 * @file x1-validator-private-rpc/src/cli/apply-watchers.js
 * @description
 * apply's sixth and seventh stages. The sixth adds `--private-rpc` to
 * x1console's start script, after saving a timestamped backup beside it,
 * which x1console's `git stash` leaves alone, and keeps the script's
 * mode. The validator takes the flag at its next start.
 *
 * The seventh installs what keeps the flag in place: x1console's git
 * hook, which runs ensure after an Update X1 Console pulls new commits,
 * and, when the operator agrees, the cron job that runs ensure every
 * minute. It makes the two folders the cron line needs, which git
 * doesn't track: without logs/ the line never runs, and without tmp/
 * its flock fails. The cron line goes in the way Autopilot adds its
 * own: the whole table is read, the one line added, and the table
 * written back, so Autopilot's jobs stay. A post-merge hook the tool
 * didn't write stays as it is, and the cron job covers for it. Last, it
 * sends a test alert when x1console's Telegram files are there.
 *
 * A later apply may find its own hook or cron line from an earlier run,
 * naming an old path to Node.js or to the tool. It replaces them, rather
 * than add beside them: it knows its hook by the hook's shape, and its
 * cron lines from its record. Each backup copy and cron line it makes
 * has an entry of its own in the record, so undo-apply removes every one.
 */

import path from "node:path";
import { homePath } from "./feature-paths.js";
import {
  isToolHook,
  renderCronLine,
  renderGitHook,
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
  if (!changed) {
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
 * Installs x1console's post-merge hook, or replaces the one an earlier
 * apply wrote, unless another program's hook is there.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function installHook(context) {
  const { host, settings, paths, record, change, log } = context;
  const homeDir = host.homeDir();
  const x1consoleDir = homePath(settings.x1consoleDir, homeDir);
  const hooks = path.join(x1consoleDir, ".git", "hooks");
  const hookPath = path.join(hooks, "post-merge");
  const key = `gitHook:${hookPath}`;
  const nodeBin = host.nodePath();
  const hook = renderGitHook({ nodeBin, toolCli: paths.toolCli });
  if (!host.exists(hooks)) {
    log.problem(
      "watchers",
      `${hooks} is missing, so there is no git hook; the cron job covers for it.`,
    );
    return;
  }
  const present = host.exists(hookPath) ? host.readText(hookPath) : null;
  if (present === hook) {
    record(found(key));
    return;
  }
  if (present !== null && !isToolHook(present)) {
    log.problem(
      "watchers",
      `${hookPath} is another program's hook, so it stays; the cron job covers for it.`,
    );
    return;
  }
  await change("watchers", `write ${hookPath}`, () => {
    host.writeUserFile(hookPath, hook, 0o755);
    record(made(key));
  });
}

/**
 * Installs the cron line that runs ensure every minute, when the
 * operator agrees and it isn't there yet. A line an earlier apply wrote,
 * which names an old path, is replaced without asking again, since the
 * operator agreed to the job then.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function installCronLine(context) {
  const { host, paths, whatApplyChanged, record, change, prompts, log } =
    context;
  const nodeBin = host.nodePath();
  const line = renderCronLine({
    nodeBin,
    toolCli: paths.toolCli,
    lockPath: paths.lockPath,
    logPath: paths.ensureLogPath,
  });
  const key = `cronLine:${line}`;
  const listed = host.run("crontab", ["-l"]);
  const table = listed.status === 0 ? listed.stdout : "";
  const entries = table.split("\n");
  if (entries.includes(line)) {
    log.info("watchers", "The cron job that runs ensure is installed already.");
    record(found(key));
    return;
  }
  const ours = [...whatApplyChanged.keys()]
    .map((recorded) => partsOf(recorded))
    .filter(({ name }) => name === "cronLine")
    .map(({ target }) => target);
  const kept = entries.filter((entry) => !ours.includes(entry));
  const replacing = kept.length < entries.length;
  const wanted =
    context.dryRun ||
    replacing ||
    (await prompts.confirm(
      "Install the cron job that runs ensure every minute?",
    ));
  if (!wanted) {
    log.info(
      "watchers",
      "No cron job: run ensure yourself after each Update X1 Console.",
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
  const what = replacing
    ? "replace the line that runs ensure in the crontab"
    : "add the line that runs ensure to the crontab";
  await change("watchers", what, () => {
    const written = host.run("crontab", ["-"], {
      input: `${rest}${separator}${line}\n`,
    });
    if (written.status !== 0) {
      throw new Error(
        `crontab refused the new table: ${written.stderr.trim()}`,
      );
    }
    record(made(key));
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
  await installCronLine(context);
  const telegram = readTelegram(host, settings);
  if (telegram === null) {
    log.info(
      "watchers",
      "x1console's Telegram files are missing, so alerts are off; ensure only logs.",
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
