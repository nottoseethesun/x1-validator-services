/**
 * @file x1-validator-private-rpc/src/cli/undo-apply.js
 * @description
 * The `undo-apply` command, apply's counterpart. It reads apply's record,
 * app-data/what-apply-changed.json, and resets each setting apply changed
 * to its old value, newest first, but leaves nginx installed, as below.
 * Those settings are:
 *
 * - the cron lines and the tool's folders
 * - the git hook
 * - the start script's flag and backups
 * - nginx's service and files, the list of the api keys' hashes among
 *   the files
 * - the saved password, and the folders apply made for it and for the
 *   api keys' file
 * - the firewall rule
 * - once nginx is gone, the account its package made, nginx.org's
 *   repository and the mask apply put on nginx.service before installing
 *   it
 *
 * A setting apply found already as it needed it stays as it is. Once
 * every change is undone, the record goes too, with the rest of
 * app-data/.
 *
 * It never removes a package, since something else may need it. So while
 * nginx is installed, its packages stay on record, with its account,
 * nginx.org's repository and the mask, which keeps nginx's default site
 * from starting. A later apply refuses an installed nginx unless the
 * record shows apply installed it. With these entries, a later apply
 * takes that nginx as its own. undo-apply says what stays, and how the
 * operator can purge nginx if they choose. Once they have, a later
 * undo-apply takes back the rest.
 *
 * The api keys aren't in the record, since keys come and go through
 * add-api-key and remove-api-key. Before any step, undo-apply asks one
 * question about them: delete every key, or keep them all. When apply
 * saved the password, the question names it too, since the password
 * opens nothing but the keys' records: a yes deletes both, and a no keeps
 * both. A yes gets sudo first, so a refused one changes nothing. Kept
 * keys stay in hashed-api-keys.json, and a later apply hands their hashes
 * to nginx again, so every client's url still works. After a yes, a later
 * apply makes a new first key, under a new password. nginx's list of
 * hashes goes either way, with nginx's other files. With --dry-run it
 * prints the question and each step, and changes nothing. While the api
 * keys' file is there, undo-apply holds the api keys' lock from its
 * question to its end, so no key command changes them meanwhile.
 *
 * It takes back only what apply did. The start script loses just the
 * word apply added, and never gets an old backup copied over a newer
 * x1console file. A flag apply didn't add stays, and undo-apply says so.
 * One example is a flag turn-on-private-rpc added after an apply that
 * stopped before its flag stage. After undo-apply's flag step, which
 * takes out apply's word or finds it gone already, undo-apply reads the
 * script again. A flag still there isn't apply's, since apply adds only
 * that word, so it says that flag stays. Otherwise it says that the rpc
 * listens on every interface from the validator's next start, unless the
 * running validator lacks the flag already. The hook goes only while
 * it's still the tool's. A folder apply made for its files goes only
 * once nothing else is in it. Root looks for a folder root made, since
 * it may sit in a folder only root can look into. A folder that goes
 * whole, with what's in it, goes only while the settings still put that
 * folder there, so a damaged record can never aim a removal elsewhere.
 *
 * A step that fails, or that the operator declines, stays in the record.
 * So does a folder, while such a step's target, or the kept api keys'
 * file, is in it. Running undo-apply again retries them.
 */

import path from "node:path";
import { installedVersion, updatePackageLists } from "../lib/apt.js";
import { mustSucceed } from "../lib/command-result.js";
import { rootLooks } from "../lib/folders-to-make.js";
import { NGINX_LOG_DIR, NGINX_PACKAGES, NGINX_UNIT } from "../lib/nginx-org.js";
import { systemctl } from "../lib/systemd.js";
import { restartAfterFlagOut, scriptCarriesFlag } from "./checks.js";
import { hashedApiKeysPathOf, startScriptPathOf } from "./feature-paths.js";
import { askSudoFirst, withApiKeysLock } from "./hashed-api-keys.js";
import { isToolHook } from "./render-watchers.js";
import { flagStaysNote, removePrivateRpc } from "./start-script.js";
import { readState, withStartScriptLock, writeState } from "./state.js";
import {
  oldValueOf,
  partsOf,
  readRecord,
  writeRecord,
} from "./what-apply-changed.js";

/** The one question about the api keys, when apply saved the password. */
export const KEYS_AND_PASSWORD_QUESTION =
  "Delete every api key and the saved password? The password opens " +
  "nothing but the keys' records, so the two go together: a no keeps " +
  "both. After a yes, a later apply makes a new key under a new " +
  "password, and every client needs a new url.";

/** The one question about the api keys, when apply saved no password. */
const KEYS_QUESTION =
  "Delete every api key? After a yes, a later apply makes a new one, and " +
  "every client needs a new url.";

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
 * Removes a folder whole, with what's in it, but only while the settings
 * still put that folder there.
 * @param {(folder: string) => void} remove  Removes a folder whole.
 * @param {string} folder  The recorded folder.
 * @param {string[]} named  Where the settings put such folders now.
 * @returns {string|null} A note when the folder stays.
 */
function removeNamedTree(remove, folder, named) {
  if (!named.includes(folder)) {
    return (
      `${folder} isn't where the settings now put it, so it stays. ` +
      "Remove it by hand if apply made it."
    );
  }
  remove(folder);
  return null;
}

/**
 * Removes a folder once nothing else is in it.
 * @param {{exists: (path: string) => boolean}} looks  What says whether
 *   the folder is there: the host for the account's own folders, and
 *   root for root's, which may sit in a folder the account can't see into.
 * @param {string} folder  The folder.
 * @param {(folder: string) => void} removeIfEmpty  Removes it when empty.
 * @returns {string|null} A note when the folder stays.
 */
function removeFolder(looks, folder, removeIfEmpty) {
  if (!looks.exists(folder)) {
    return null;
  }
  removeIfEmpty(folder);
  const stays = looks.exists(folder);
  return stays === true
    ? `${folder} holds files apply didn't make, so it stays.`
    : null;
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
 * Its step holds the start script's lock, so an ensure that's running
 * can't put the flag back in between.
 * @param {object} host  The host.
 * @param {string} scriptPath  The start script.
 */
function removeFlag(host, scriptPath) {
  const original = host.readText(scriptPath);
  const { text, changed } = removePrivateRpc(original, scriptPath);
  if (changed === true) {
    const mode = host.fileMode(scriptPath);
    host.writeUserFile(scriptPath, text, mode);
  }
}

/**
 * What undo-apply says once its flag step is done. A flag still in the
 * start script isn't apply's, since apply adds only the word the step
 * takes out, so it stays, and the note says so. Otherwise it says that
 * the rpc listens on every interface from the validator's next start,
 * unless the running validator lacks the flag already.
 * @param {object} host  The host.
 * @param {string} scriptPath  The start script.
 * @returns {string|null} The line, or null when a restart changes nothing.
 */
function afterFlagOut(host, scriptPath) {
  if (scriptCarriesFlag(host, scriptPath)) {
    return flagStaysNote(scriptPath, "apply");
  }
  return restartAfterFlagOut(host, scriptPath);
}

/**
 * Says so when the start script carries a --private-rpc that apply didn't
 * add, such as one turn-on-private-rpc added after an apply that stopped
 * before its flag stage. undo-apply leaves it, so the validator's rpc
 * stays private after its next start too.
 * @param {object} run  The run.
 * @param {Set<string>} names  The settings apply changed.
 * @returns {string|null} The note, or null when apply added the flag, or
 *   when the script lacks it or can't be read.
 */
function flagStays({ host, settings }, names) {
  if (names.has("privateRpcFlag")) {
    return null;
  }
  const homeDir = host.homeDir();
  const scriptPath = startScriptPathOf(settings, homeDir);
  return scriptCarriesFlag(host, scriptPath)
    ? flagStaysNote(scriptPath, "apply")
    : null;
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
 * What undo-apply says when it leaves nginx installed. It never removes a
 * package, since something else may need it. While nginx is installed it
 * keeps nginx's packages, account, repository and mask on record, so a
 * later apply takes this nginx as its own. The purge it names is the
 * operator's to choose, and once they've made it, a later undo-apply
 * removes the rest.
 */
export const NGINX_STAYS =
  "nginx stays installed, with its two modules, since undo-apply removes " +
  "no package: something else may need them. Its configuration in " +
  "/etc/nginx, its certificates in /var/cache/nginx, its logs in " +
  `${NGINX_LOG_DIR}, its account and nginx.org's apt repository stay too. ` +
  `Its packages, its account, the repository and the mask on ${NGINX_UNIT} ` +
  "stay listed in x1-validator-private-rpc/app-data/what-apply-changed.json. " +
  "A later apply refuses an installed nginx unless that file shows apply " +
  "installed it. With these entries, a later apply takes this nginx as its " +
  "own, and reuses its certificate. If you want nginx gone, first run sudo " +
  "apt-mark unhold nginx, if you hold it. Then run sudo apt purge " +
  `${NGINX_PACKAGES.join(" ")}. Then run undo-apply again, which removes ` +
  "nginx's account, nginx.org's repository and the mask.";

/**
 * What undo-apply says when nginx is gone already at its package step. A
 * removal by hand with apt remove keeps nginx's configuration, its
 * certificates and its logs, which only a purge deletes.
 */
export const NGINX_GONE_ALREADY =
  "nginx isn't installed. If it was removed with apt remove rather than " +
  "purged, its configuration in /etc/nginx, its certificates in " +
  `/var/cache/nginx and its logs in ${NGINX_LOG_DIR} may still be there. ` +
  "If you want them gone, sudo apt purge nginx deletes them.";

/**
 * Tells whether a package is installed.
 * @param {object} host  The host.
 * @param {string} name  The package.
 * @returns {boolean}
 */
function isInstalled(host, name) {
  const version = installedVersion(host, name);
  return version !== undefined && version !== null;
}

/**
 * Says that a package on record isn't installed. apply records each
 * package just before apt installs them, so a run that died part way can
 * leave one on record that apt never installed. The operator may also
 * have removed one by hand.
 * @param {string} name  The package.
 * @returns {string} The note.
 */
function packageGone(name) {
  return name === "nginx" ? NGINX_GONE_ALREADY : `${name} isn't installed.`;
}

/**
 * Stops, disables and masks nginx.service, when nginx is installed. Once
 * its package is gone, so is the unit, and systemctl refuses to disable
 * a unit that isn't there.
 * @param {object} host  The host.
 * @returns {string|null} A note when nginx isn't installed.
 */
function stopNginx(host) {
  if (!isInstalled(host, "nginx")) {
    return "nginx isn't installed, so there's nothing to stop, disable or mask.";
  }
  systemctl(host, ["disable", "--now", NGINX_UNIT]);
  systemctl(host, ["mask", NGINX_UNIT]);
  return null;
}

/**
 * Removes the nginx account its package made, since the package leaves
 * its account behind. undo-apply removes it only once nginx is gone,
 * since nginx's files belong to it.
 * @param {object} host  The host.
 */
function removeAccount(host) {
  const account = host.run("getent", ["passwd", "nginx"]);
  if (account.status === 0) {
    const removed = host.sudo("userdel", ["nginx"]);
    mustSucceed(removed, "Removing nginx's account");
  }
}

/**
 * Lists the step that resets one setting apply changed.
 * @param {object} context  The run, with `keysKept`: whether the
 *   operator kept the api keys, and so the saved password.
 * @param {string} key  The setting.
 * @param {import("./what-apply-changed.js").Entry} entry  Its entry.
 * @returns {{what: string, declined?: boolean, keep?: boolean,
 *   note?: string, after?: () => (string|null),
 *   run?: () => (unknown|Promise<unknown>)}} The step, with `declined`
 *   for one the operator's answer keeps, and `keep` for a setting that
 *   stays: one this version of the tool can't reset, or one that stays
 *   with nginx while it's installed, which `note` says. `after` gives a
 *   line to print once it's done, or null for none.
 */
function resetStep(context, key, entry) {
  const { host, settings, paths, keysKept } = context;
  const { name, target } = partsOf(key);
  const old = oldValueOf(entry);
  const asRoot = rootLooks(host);
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
      removeFolder(asRoot, target, (empty) => host.removeRootDirIfEmpty(empty)),
  });
  const rootFile = () => ({
    what: `remove ${target}`,
    run: () => removeRootFile(host, name, target),
  });
  const certificates = rootTree(`remove nginx's certificate folder ${target}`, [
    settings.acmeStatePath,
    settings.acmeStagingStatePath,
  ]);
  /*-
   * While nginx is installed, what belongs with it stays on record, so a
   * later apply takes it as its own, and a later undo-apply, once the
   * operator has purged nginx, takes it back.
   */
  const whileNginx = (what, note, make) => () =>
    isInstalled(host, "nginx") ? { what, keep: true, note } : make();
  const repositoryFile = whileNginx(
    target,
    `${target} stays while nginx is installed, for nginx's updates.`,
    rootFile,
  );
  const cronCommand =
    / (ensure\S*) --quiet /.exec(target)?.at(1) ?? "a command";
  const steps = {
    cronLine: () => ({
      what: `remove the line that runs ${cronCommand} from the crontab`,
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
      run: () =>
        withStartScriptLock(host, paths.statePath, () =>
          removeFlag(host, target),
        ),
      after: () => afterFlagOut(host, target),
    }),
    startScriptBackup: () => ({
      what: `remove ${target}`,
      run: () => host.removeUserFile(target),
    }),
    nginxServiceEnabled: () => ({
      what: `stop, disable and mask ${NGINX_UNIT}`,
      run: () => stopNginx(host),
    }),
    acmeStateFolder: certificates,
    acmeStagingStateFolder: certificates,
    njsModuleFile: rootFile,
    nginxConfigFile: rootFile,
    systemdDropInFile: rootFile,
    hashedApiKeysMapFile: rootFile,
    nginxFileFolder: rootFolder,
    // The question about the api keys, asked first, covers it.
    savedPassword: () => ({
      what: `delete the saved password, ${target}`,
      declined: keysKept,
      run: () => host.removeRootFile(target),
    }),
    savedPasswordFolder: rootFolder,
    hashedApiKeysFolder: () => ({
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
    nginxPackage: () =>
      isInstalled(host, target)
        ? {
            what: `the ${target} package`,
            keep: true,
            note:
              target === "nginx"
                ? NGINX_STAYS
                : `${target} stays installed, with nginx.`,
          }
        : {
            what: `note that ${target} isn't installed`,
            run: () => packageGone(target),
          },
    nginxAccount: whileNginx(
      "the nginx account",
      "nginx's account stays while nginx is installed.",
      () => ({
        what: "remove the nginx account its package made",
        run: () => removeAccount(host),
      }),
    ),
    nginxAptKeyring: repositoryFile,
    nginxAptSource: repositoryFile,
    nginxAptPin: repositoryFile,
    nginxServiceMasked:
      old === true
        ? () => ({
            what: `mask ${NGINX_UNIT}`,
            run: () => systemctl(host, ["mask", NGINX_UNIT]),
          })
        : whileNginx(
            `the mask on ${NGINX_UNIT}`,
            `${NGINX_UNIT} stays masked while nginx is installed. With the ` +
              "tool's files gone, a start of nginx would run the package's " +
              "own configuration and its default site. The mask stops " +
              "anything from starting it.",
            () => ({
              what: `unmask ${NGINX_UNIT}`,
              run: () => systemctl(host, ["unmask", NGINX_UNIT]),
            }),
          ),
  };
  const make = new Map(Object.entries(steps)).get(name);
  const resettable =
    old === false || (name === "nginxServiceMasked" && old === true);
  return make === undefined || make === null || resettable === false
    ? {
        what: `${key}, a change this version of the tool can't undo`,
        keep: true,
      }
    : make();
}

/**
 * Finds what this change waits for: a change still in the record whose
 * target sits in this one's, such as the saved password in its folder,
 * or the kept api keys' file, in the folder apply made for it.
 * @param {string} key  The setting.
 * @param {Map<string, object>} left  The changes that stay in the record.
 * @param {string[]} stays  Files outside the record that stay.
 * @returns {string|null} What holds it back, or null.
 */
function heldBy(key, left, stays) {
  const { target } = partsOf(key);
  const holder = [
    ...[...left.keys()].map((other) => partsOf(other).target),
    ...stays,
  ].find(
    (other) =>
      target !== "" && (other === target || other.startsWith(`${target}/`)),
  );
  return holder === undefined || holder === null ? null : holder;
}

/**
 * Runs one step, unless it keeps its change or the operator said no.
 * @param {object} run  The run.
 * @param {object} step  The step.
 * @returns {Promise<"done"|"kept"|"failed">}
 */
async function runStep(run, step) {
  const { log } = run;
  if (step.keep === true) {
    log.info("undo-apply", step.note ?? `Kept: ${step.what}.`);
    return "kept";
  }
  if (step.declined === true) {
    log.info("undo-apply", `Skipped, as asked: ${step.what}.`);
    return "kept";
  }
  try {
    const note = await step.run();
    log.info(
      "undo-apply",
      typeof note === "string" ? note : `Done: ${step.what}.`,
    );
    const after = step.after?.();
    if (after !== undefined && after !== null) {
      log.info("undo-apply", after);
    }
    return "done";
  } catch (error) {
    log.problem("undo-apply", `Couldn't ${step.what}: ${error.message}`);
    return "failed";
  }
}

/**
 * Asks the one question about the api keys, and deletes their file on a
 * yes.
 * @param {object} run  The run.
 * @param {string} filePath  The api keys' file.
 * @param {boolean} paired  Whether apply saved the password, which goes
 *   with the keys.
 * @returns {Promise<boolean>} Whether the keys stay.
 * @throws {Error} When sudo refuses after a yes, before anything changes,
 *   so the api keys' file and nginx's list still agree.
 */
async function askAboutKeys(run, filePath, paired) {
  const { host, log, prompts, options } = run;
  const question = paired === true ? KEYS_AND_PASSWORD_QUESTION : KEYS_QUESTION;
  if (options.dryRun === true) {
    log.info("undo-apply", `Would ask: ${question}`);
    log.info(
      "undo-apply",
      `After a yes, it would first delete every api key, with ${filePath}. ` +
        "The steps below assume that yes.",
    );
    return false;
  }
  if (!(await prompts.ask(question))) {
    log.info(
      "undo-apply",
      `Kept, as asked: every api key, in ${filePath}. A later apply hands ` +
        "them to nginx again.",
    );
    return true;
  }
  /*-
   * sudo first, as the key commands get it, so a refused one leaves the
   * file, and nginx's list keeps no key the file has lost.
   */
  askSudoFirst(host);
  host.removeUserFile(filePath);
  log.info("undo-apply", `Done: deleted every api key, with ${filePath}.`);
  return false;
}

/**
 * Runs each change's step, newest first, unless what it waits for stays.
 * @param {object} context  The run, with keysKept.
 * @param {[string, object][]} newestFirst  The changes apply made.
 * @param {string[]} stays  Files outside the record that stay.
 * @returns {Promise<{left: Map<string, object>, failed: boolean}>} The
 *   changes that stay in the record, and whether a step failed.
 */
async function runSteps(context, newestFirst, stays) {
  const left = new Map();
  let failed = false;
  for (const [key, entry] of newestFirst) {
    const step = resetStep(context, key, entry);
    const holder = heldBy(key, left, stays);
    const held = holder !== undefined && holder !== null;
    if (held === true) {
      context.log.info(
        "undo-apply",
        `Skipped, since ${holder} stays: ${step.what}.`,
      );
    }
    const outcome = held === true ? "kept" : await runStep(context, step);
    if (outcome !== "done") {
      left.set(key, entry);
    }
    if (outcome === "failed") {
      failed = true;
    }
  }
  return { left, failed };
}

/**
 * Undoes what apply did, after the question about the api keys.
 * @param {object} run  The run.
 * @param {string} filePath  The api keys' file.
 * @param {boolean} fileThere  Whether the file was there at the start.
 * @returns {Promise<number>} The exit code.
 */
async function undoAll(run, filePath, fileThere) {
  const { host, paths, log, options } = run;
  const recordPath = paths.whatApplyChangedPath;
  const record = readRecord(host, recordPath) ?? new Map();
  const newestFirst = [...record]
    .filter(([, entry]) => entry.applyChangedThisFromItsPreviousValue === true)
    .reverse();
  const names = new Set(newestFirst.map(([key]) => partsOf(key).name));
  const paired = names.has("savedPassword");
  const keysKept =
    fileThere === true && (await askAboutKeys(run, filePath, paired));
  if (newestFirst.length === 0) {
    log.info(
      "undo-apply",
      fileThere === true
        ? "apply hasn't changed anything else here."
        : "apply hasn't changed anything here, so there is nothing to undo.",
    );
    return 0;
  }
  const context = { ...run, keysKept };
  if (options.dryRun === true) {
    for (const [key, entry] of newestFirst) {
      const step = resetStep(context, key, entry);
      log.info(
        "undo-apply",
        step.keep === true ? `Would keep ${step.what}.` : `Would ${step.what}.`,
      );
    }
    return 0;
  }
  const stays = keysKept === true ? [filePath] : [];
  const { left, failed } = await runSteps(context, newestFirst, stays);
  const flagNote = flagStays(run, names);
  if (flagNote !== undefined && flagNote !== null) {
    log.info("undo-apply", flagNote);
  }
  if (left.size === 0) {
    host.removeUserTree(path.dirname(recordPath));
    log.info("undo-apply", "Everything apply did is undone.");
    return 0;
  }
  const oldestFirst = new Map([...left].reverse());
  writeRecord(host, recordPath, oldestFirst);
  const state = readState(host, paths.statePath);
  if (state !== undefined && state !== null) {
    state.setup = null;
    /*-
     * Unset, as on a first install, so that no ensure adds the flag
     * before apply does. A later apply records the setup again at its
     * fifth stage, which starts nginx, and from then on ensure acts on
     * the choice. But apply adds the flag only at its sixth stage, and
     * installs the cron job and the git hook that run ensure only at its
     * seventh. Say undo-apply left the choice on, and that later apply
     * stopped between its fifth and sixth stages. An ensure run by hand
     * would then add the flag. When apply ran again, it would find that
     * flag and record it as found, not as its own change. The next
     * undo-apply takes back only apply's changes, so it would leave the
     * flag, and the rpc would stay private after the validator's next
     * start.
     */
    state.privateRpc = "";
    writeState(host, paths.statePath, state);
  }
  log.info(
    "undo-apply",
    `The steps above that failed, were skipped or were kept stay in ${recordPath}. ` +
      "Running undo-apply again retries those that failed or were skipped. " +
      "Any kept while nginx is installed go at the first run after you " +
      "purge nginx.",
  );
  return failed === true ? 1 : 0;
}

/**
 * Runs undo-apply. While the api keys' file is there, it holds their
 * lock from its question to its end, as the key commands do, so none of
 * them changes the keys or nginx's list while it takes them apart.
 * @param {object} run  What undo-apply works with: host, settings,
 *   paths, log, prompts, and options {dryRun}.
 * @returns {Promise<number>} The exit code: 1 when a step failed, 0
 *   otherwise.
 * @throws {Error} Before any change: when another command holds the api
 *   keys' lock, since the two commands' changes would undo each other, or
 *   when sudo refuses after the yes, so the api keys' file and nginx's
 *   list still agree.
 */
export async function runUndoApply(run) {
  const { host, settings, options } = run;
  const homeDir = host.homeDir();
  const filePath = hashedApiKeysPathOf(settings, homeDir);
  const fileThere = host.exists(filePath);
  if (fileThere === true && options.dryRun !== true) {
    const folder = path.dirname(filePath);
    return withApiKeysLock(host, folder, () =>
      undoAll(run, filePath, fileThere),
    );
  }
  return undoAll(run, filePath, fileThere);
}
