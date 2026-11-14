/**
 * @file x1-validator-private-rpc/src/cli/undo-apply.js
 * @description
 * The `undo-apply` command, apply's counterpart. It reads apply's record,
 * app-data/what-apply-changed.json, and resets each setting apply changed
 * to its old value, newest first, until the machine is as apply found
 * it. Those settings are:
 *
 * - the cron line and the tool's folders
 * - the git hook
 * - the start script's flag and backups
 * - nginx's service, files, logs and certificates
 * - the saved password, the api key and the vault
 * - the firewall rule
 * - nginx's packages, and the account their package made
 * - nginx.org's repository
 * - the mask apply put on nginx.service before installing it
 *
 * A setting apply found already as it needed it stays as it is. Once
 * every change is undone, the record goes too, with the rest of
 * app-data/. It asks before it deletes the saved password or the api key,
 * since a later apply would then need a new password or give clients a
 * new url. With --dry-run it prints each step and changes nothing.
 *
 * It takes back only what apply did. The start script loses just the
 * word apply added, and never gets an old backup copied over a newer
 * x1console file. The hook goes only while it's still the tool's. A
 * folder apply made for its files goes only once nothing else is in it.
 * A folder that goes whole, with what nginx or the cron job wrote in it,
 * goes only while the settings still put that folder there, so a damaged
 * record can never aim a removal elsewhere.
 *
 * nginx stays masked until it's gone, so its package's default site
 * never runs, and its account stays until then too. A step that fails,
 * or that the operator declines, stays in the record. So does a folder,
 * or the vault, while such a step's target is in it. Running undo-apply
 * again retries them.
 */

import path from "node:path";
import {
  installedVersion,
  purgePackages,
  updatePackageLists,
} from "../lib/apt.js";
import { mustSucceed } from "../lib/command-result.js";
import { NGINX_UNIT } from "../lib/nginx-org.js";
import { systemctl } from "../lib/systemd.js";
import { isToolHook } from "./render-watchers.js";
import { removePrivateRpc } from "./start-script.js";
import { readState, writeState } from "./state.js";
import {
  API_KEY_SECRET,
  readVault,
  withoutSecret,
  writeVault,
} from "./vault.js";
import {
  oldValueOf,
  partsOf,
  readRecord,
  writeRecord,
} from "./what-apply-changed.js";

/**
 * Removes apply's line from the crontab, keeping every other line.
 * @param {object} host  The host.
 * @param {string} line  The line.
 */
function removeCronLine(host, line) {
  const listed = host.run("crontab", ["-l"]);
  if (listed.status !== 0) {
    return;
  }
  const kept = listed.stdout.split("\n").filter((entry) => entry !== line);
  const written = host.run("crontab", ["-"], { input: kept.join("\n") });
  if (written.status !== 0) {
    throw new Error(`crontab refused the table: ${written.stderr.trim()}`);
  }
}

/**
 * Removes a folder whole, with what nginx or the cron job wrote in it,
 * but only while the settings still put that folder there.
 * @param {(folder: string) => void} remove  Removes a folder whole.
 * @param {string} folder  The recorded folder.
 * @param {string[]} named  Where the settings put such folders now.
 * @returns {string|null} A note when the folder stays.
 */
function removeNamedTree(remove, folder, named) {
  if (!named.includes(folder)) {
    return (
      `${folder} isn't where the settings now put it, so it stays; ` +
      "remove it by hand if apply made it."
    );
  }
  remove(folder);
  return null;
}

/**
 * Removes a folder once nothing else is in it.
 * @param {object} host  The host.
 * @param {string} folder  The folder.
 * @param {(folder: string) => void} removeIfEmpty  Removes it when empty.
 * @returns {string|null} A note when the folder stays.
 */
function removeFolder(host, folder, removeIfEmpty) {
  if (!host.exists(folder)) {
    return null;
  }
  removeIfEmpty(folder);
  const stays = host.exists(folder);
  return stays ? `${folder} holds files apply didn't make, so it stays.` : null;
}

/**
 * Removes the git hook while it's still the tool's.
 * @param {object} host  The host.
 * @param {string} hookPath  The hook.
 * @returns {string|null} A note when the hook stays.
 */
function removeHook(host, hookPath) {
  if (!host.exists(hookPath)) {
    return null;
  }
  const text = host.readText(hookPath);
  if (!isToolHook(text)) {
    return `${hookPath} changed since apply wrote it, so it stays.`;
  }
  host.removeUserFile(hookPath);
  return null;
}

/**
 * Takes the flag apply added out of the start script, keeping its mode.
 * @param {object} host  The host.
 * @param {string} scriptPath  The start script.
 */
function removeFlag(host, scriptPath) {
  const original = host.readText(scriptPath);
  const { text, changed } = removePrivateRpc(original, scriptPath);
  if (changed) {
    const mode = host.fileMode(scriptPath);
    host.writeUserFile(scriptPath, text, mode);
  }
}

/**
 * Removes one of the files apply wrote as root. After the drop-in it
 * reloads systemd, and after nginx.org's apt source it refreshes apt's
 * package lists, so nginx.org's lists go too.
 * @param {object} host  The host.
 * @param {string} name  The file's setting, such as `systemdDropInFile`.
 * @param {string} filePath  The file.
 * @returns {Promise<void>}
 */
async function removeRootFile(host, name, filePath) {
  host.removeRootFile(filePath);
  if (name === "systemdDropInFile") {
    systemctl(host, ["daemon-reload"]);
  }
  if (name === "nginxAptSource") {
    await updatePackageLists(host);
  }
}

/**
 * Deletes the api key from the vault.
 * @param {object} host  The host.
 * @param {string} vaultPath  The vault's file.
 */
function deleteKey(host, vaultPath) {
  const vault = readVault(host, vaultPath);
  if (vault !== null) {
    const rest = withoutSecret(vault, API_KEY_SECRET);
    writeVault(host, vaultPath, rest);
  }
}

/**
 * Removes the vault apply made, once it holds no secret.
 * @param {object} host  The host.
 * @param {string} vaultPath  The vault's file.
 * @returns {string|null} A note when the vault stays.
 */
function removeVault(host, vaultPath) {
  const vault = readVault(host, vaultPath);
  if (vault === null) {
    return null;
  }
  if (Object.keys(vault.secrets).length > 0) {
    return `${vaultPath} holds other secrets, so it stays.`;
  }
  host.removeUserFile(vaultPath);
  return null;
}

/**
 * Purges one of nginx.org's packages, when it's installed. apply records
 * each package just before apt installs them, so a run that died part way
 * can leave one on record that apt never installed.
 * @param {object} host  The host.
 * @param {string} name  The package.
 * @returns {Promise<string|null>} A note when the package isn't there.
 */
async function removePackage(host, name) {
  if (installedVersion(host, name) === null) {
    return `${name} isn't installed, so there's nothing to remove.`;
  }
  await purgePackages(host, [name]);
  return null;
}

/**
 * Removes the nginx account its package made, once nginx is gone, since
 * the package leaves its account behind.
 * @param {object} host  The host.
 * @throws {Error} While nginx is still installed, since its files belong
 *   to that account; the account stays in the record, for the next run.
 */
function removeAccount(host) {
  const version = installedVersion(host, "nginx");
  if (version !== null) {
    throw new Error(
      `nginx ${version} is still installed, so its account stays until it's gone.`,
    );
  }
  const account = host.run("getent", ["passwd", "nginx"]);
  if (account.status === 0) {
    const removed = host.sudo("userdel", ["nginx"]);
    mustSucceed(removed, "Removing nginx's account");
  }
}

/**
 * Unmasks nginx.service once nginx is gone.
 * @param {object} host  The host.
 * @throws {Error} While nginx is still installed, since its default site
 *   could then run; the mask stays in the record, for the next run.
 */
function unmaskNginx(host) {
  const version = installedVersion(host, "nginx");
  if (version !== null) {
    throw new Error(
      `nginx ${version} is still installed, so the mask stays until it's gone.`,
    );
  }
  systemctl(host, ["unmask", NGINX_UNIT]);
}

/**
 * Lists the step that resets one setting apply changed.
 * @param {object} context  The run.
 * @param {string} key  The setting.
 * @param {import("./what-apply-changed.js").Entry} entry  Its entry.
 * @returns {{what: string, ask?: string, keep?: boolean,
 *   run?: () => (unknown|Promise<unknown>)}} The step; `keep` for a
 *   setting this version of the tool can't reset.
 */
function resetStep(context, key, entry) {
  const { host, settings, paths } = context;
  const { name, target } = partsOf(key);
  const old = oldValueOf(entry);
  const rootTree = (what, named) => () => ({
    what,
    run: () =>
      removeNamedTree((tree) => host.removeRootTree(tree), target, named),
  });
  const toolFolder = () => ({
    what: `remove ${target}`,
    run: () =>
      removeNamedTree((tree) => host.removeUserTree(tree), target, [
        paths.tmpDir,
        paths.logsDir,
      ]),
  });
  const rootFolder = () => ({
    what: `remove the folder ${target}`,
    run: () =>
      removeFolder(host, target, (empty) => host.removeRootDirIfEmpty(empty)),
  });
  const rootFile = () => ({
    what: `remove ${target}`,
    run: () => removeRootFile(host, name, target),
  });
  const certificates = rootTree(`remove nginx's certificate folder ${target}`, [
    settings.acmeStatePath,
    settings.acmeStagingStatePath,
  ]);
  const handOffFolder = path.dirname(settings.keyHandOffPath);
  const steps = {
    cronLine: () => ({
      what: "remove the line that runs ensure from the crontab",
      run: () => removeCronLine(host, target),
    }),
    toolTmpFolder: toolFolder,
    toolLogsFolder: toolFolder,
    gitHook: () => ({
      what: `remove ${target}`,
      run: () => removeHook(host, target),
    }),
    privateRpcFlag: () => ({
      what: `take --private-rpc out of ${target}`,
      run: () => removeFlag(host, target),
    }),
    startScriptBackup: () => ({
      what: `remove ${target}`,
      run: () => host.removeUserFile(target),
    }),
    keyHandOffFolder: rootTree(`remove the key's hand-off folder ${target}`, [
      handOffFolder,
    ]),
    nginxServiceEnabled: () => ({
      what: `stop, disable and mask ${NGINX_UNIT}`,
      run: () => {
        systemctl(host, ["disable", "--now", NGINX_UNIT]);
        systemctl(host, ["mask", NGINX_UNIT]);
      },
    }),
    acmeStateFolder: certificates,
    acmeStagingStateFolder: certificates,
    nginxLogFolder: rootTree(`remove nginx's log folder ${target}`, [
      settings.nginxLogDir,
    ]),
    njsModuleFile: rootFile,
    nginxConfigFile: rootFile,
    startWrapperFile: rootFile,
    systemdDropInFile: rootFile,
    logrotateRuleFile: rootFile,
    nginxFileFolder: rootFolder,
    savedPassword: () => ({
      what: `delete the saved password, ${target}`,
      ask: "Delete the saved password? Without it, nginx stays locked after a restart until unlock.",
      run: () => host.removeRootFile(target),
    }),
    savedPasswordFolder: rootFolder,
    apiKey: () => ({
      what: `delete the api key from ${target}`,
      ask: "Delete the api key? A later apply makes a new one, and every client then needs the new url.",
      run: () => deleteKey(host, target),
    }),
    vault: () => ({
      what: `remove the vault ${target}`,
      run: () => removeVault(host, target),
    }),
    vaultFolder: () => ({
      what: `remove the folder ${target}`,
      run: () =>
        removeFolder(host, target, (empty) => host.removeUserDirIfEmpty(empty)),
    }),
    firewallRule: () => ({
      what: `run ufw delete allow ${target}`,
      run: () => {
        const deleted = host.sudo("ufw", ["delete", "allow", target]);
        mustSucceed(deleted, `Removing ${target}`);
      },
    }),
    nginxPackage: () => ({
      what: `remove the ${target} package`,
      run: () => removePackage(host, target),
    }),
    nginxAccount: () => ({
      what: "remove the nginx account its package made",
      run: () => removeAccount(host),
    }),
    nginxAptKeyring: rootFile,
    nginxAptSource: rootFile,
    nginxAptPin: rootFile,
    nginxServiceMasked: () =>
      old === true
        ? {
            what: `mask ${NGINX_UNIT}`,
            run: () => systemctl(host, ["mask", NGINX_UNIT]),
          }
        : { what: `unmask ${NGINX_UNIT}`, run: () => unmaskNginx(host) },
  };
  const make = new Map(Object.entries(steps)).get(name);
  const resettable =
    old === false || (name === "nginxServiceMasked" && old === true);
  return make === undefined || make === null || !resettable
    ? {
        what: `${key}, a change this version of the tool can't undo`,
        keep: true,
      }
    : make();
}

/**
 * Finds a change still in the record whose target sits in this one's,
 * such as the api key in the vault, or the saved password in its
 * folder, so this one waits for it.
 * @param {string} key  The setting.
 * @param {Map<string, object>} left  The changes that stay in the record.
 * @returns {string|null} What holds it back, or null.
 */
function heldBy(key, left) {
  const { target } = partsOf(key);
  const inner = [...left.keys()]
    .map((other) => partsOf(other).target)
    .find(
      (other) =>
        target !== "" && (other === target || other.startsWith(`${target}/`)),
    );
  return inner === undefined || inner === null ? null : inner;
}

/**
 * Runs one step, unless it keeps its change or the operator says no.
 * @param {object} run  The run.
 * @param {object} step  The step.
 * @returns {Promise<"done"|"kept"|"failed">}
 */
async function runStep(run, step) {
  const { log, prompts } = run;
  if (step.keep === true) {
    log.info("undo-apply", `Kept: ${step.what}.`);
    return "kept";
  }
  const asks = step.ask !== undefined && step.ask !== null;
  if (asks && !(await prompts.ask(step.ask))) {
    log.info("undo-apply", `Kept, as asked: the change behind "${step.what}".`);
    return "kept";
  }
  try {
    const note = await step.run();
    log.info(
      "undo-apply",
      typeof note === "string" ? note : `Done: ${step.what}.`,
    );
    return "done";
  } catch (error) {
    log.problem("undo-apply", `Couldn't ${step.what}: ${error.message}`);
    return "failed";
  }
}

/**
 * Runs undo-apply.
 * @param {object} run  What undo-apply works with: host, settings,
 *   paths, log, prompts, and options {dryRun}.
 * @returns {Promise<number>} The exit code: 1 when a step failed, 0
 *   otherwise.
 */
export async function runUndoApply(run) {
  const { host, paths, log, options } = run;
  const recordPath = paths.whatApplyChangedPath;
  const record = readRecord(host, recordPath) ?? new Map();
  const newestFirst = [...record]
    .filter(([, entry]) => entry.applyChangedThisFromItsPreviousValue)
    .reverse();
  if (newestFirst.length === 0) {
    log.info(
      "undo-apply",
      "apply hasn't changed anything here, so there is nothing to undo.",
    );
    return 0;
  }
  if (options.dryRun === true) {
    for (const [key, entry] of newestFirst) {
      const step = resetStep(run, key, entry);
      log.info(
        "undo-apply",
        step.keep === true ? `Would keep ${step.what}.` : `Would ${step.what}.`,
      );
    }
    return 0;
  }
  const left = new Map();
  let failed = false;
  for (const [key, entry] of newestFirst) {
    const step = resetStep(run, key, entry);
    const holder = heldBy(key, left);
    if (holder !== null) {
      log.info(
        "undo-apply",
        `Kept, since ${holder} stays: the change behind "${step.what}".`,
      );
    }
    const outcome = holder === null ? await runStep(run, step) : "kept";
    if (outcome !== "done") {
      left.set(key, entry);
    }
    failed = failed || outcome === "failed";
  }
  if (left.size === 0) {
    host.removeUserTree(path.dirname(recordPath));
    log.info("undo-apply", "Everything apply did is undone.");
    return 0;
  }
  const oldestFirst = new Map([...left].reverse());
  writeRecord(host, recordPath, oldestFirst);
  const state = readState(host, paths.statePath);
  if (state !== null) {
    state.setup = null;
    writeState(host, paths.statePath, state);
  }
  return failed ? 1 : 0;
}
