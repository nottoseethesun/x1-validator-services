/**
 * @file x1-validator-private-rpc/src/cli/apply-nginx.js
 * @description
 * apply's fifth stage: nginx's own files, then nginx itself. It writes
 * the key check, the configuration and the systemd drop-in, each only
 * when it's missing or differs, and refuses to write over a file apply
 * didn't write. It makes nginx's log folder again if it's gone, since
 * nginx can open no log without it. Then it has nginx test the
 * configuration, which also fails when the public address isn't on the
 * machine, or when the fourth stage's list of the api keys' hashes is
 * missing. Only then does it reload systemd.
 *
 * When nginx refuses, the stage puts back every file it wrote as it was,
 * removing ones it made new, and stops. Neither the running nginx nor
 * systemd has read the new files by then, so the files on disk again
 * match what both run. Without that, a later apply would find the files
 * in place and take them as done. It would never test the configuration
 * again, so each key command's reload would fail without a word, leaving
 * a removed key working. Nor would it restart nginx for the drop-in. The
 * next start, often a reboot, would then load the refused configuration,
 * so nginx wouldn't start. What the run wrote, and why nginx refused it,
 * go into the tool's error log for the operator.
 *
 * nginx then starts when it's stopped. A running nginx reloads when a
 * file changed, which keeps it answering throughout. It restarts instead
 * when the drop-in changed, since systemd applies the drop-in only at a
 * start, or when it doesn't answer the gate page. With nothing changed
 * and the gate page answering, the stage skips nginx -t and leaves nginx
 * as it is. When the fourth stage made no key either, the stage ends
 * there. Otherwise it waits for the certificate, and checks the whole
 * request path from the server: the gate page says ok, the keyed path
 * reaches the rpc when the fourth stage made a key, and a path without a
 * key, or with a random one, gets a 403. It runs the checks again until
 * they pass, for up to certificateWaitSeconds, since a reload takes a
 * moment, while nginx still checks against its old list of keys. Before
 * the first start it records the certificates' folders. `nginx -t` makes
 * those first, so apply records them as found. They stay with nginx,
 * which undo-apply never removes, and a purge of nginx removes them at
 * the shipped paths.
 */

import path from "node:path";
import { foldersToMake, rootLooks } from "../lib/folders-to-make.js";
import { GATE_PAGE_NAME } from "../lib/gate-page.js";
import {
  NGINX_LOG_DIR,
  NGINX_LOG_DIR_MODE,
  NGINX_UNIT,
} from "../lib/nginx-org.js";
import { pollUntil } from "../lib/poll.js";
import { renderDropIn } from "../lib/render-host-files.js";
import { systemctl, unitActiveState, unitFileState } from "../lib/systemd.js";
import { checkedKey } from "./apply-key.js";
import {
  readGate,
  requestPathProblems,
  targetOf,
  waitForGate,
} from "./nginx-gate.js";
import { renderNginxConfig } from "./render-nginx.js";
import {
  changedByApply,
  found,
  made,
  recordFoldersMade,
} from "./what-apply-changed.js";

/**
 * Lists the files the stage writes, with their settings' names, their
 * text and their mode.
 * @param {object} context  The run.
 * @returns {{name: string, path: string, text: string, mode: string}[]}
 */
function nginxFiles(context) {
  const { host, settings, facts, paths, staging } = context;
  const keyCheck = host.readText(paths.njsModuleSource);
  return [
    {
      name: "njsModuleFile",
      path: settings.njsModulePath,
      text: keyCheck,
      mode: "0644",
    },
    {
      name: "nginxConfigFile",
      path: settings.nginxConfigPath,
      text: renderNginxConfig({
        hostname: settings.hostname,
        publicIp: facts.publicIp,
        rpcPort: facts.rpcPort,
        resolver: facts.resolver,
        staging,
        settings,
      }),
      mode: "0644",
    },
    {
      name: "systemdDropInFile",
      path: settings.systemdDropInPath,
      text: renderDropIn({ nginxConfigPath: settings.nginxConfigPath }),
      mode: "0644",
    },
  ];
}

/**
 * Writes one root-owned file when it's missing or differs, recording the
 * file and each folder its write creates.
 * @param {object} context  The run.
 * @param {{name: string, path: string, text: string, mode: string}} file
 *   The file.
 * @returns {Promise<boolean>} Whether it wrote the file.
 * @throws {Error} When the file exists, differs from what apply would
 *   write, and apply didn't write it, since writing over it would lose a
 *   file someone else made.
 */
async function writeFile(context, file) {
  const { host, record, change } = context;
  const key = `${file.name}:${file.path}`;
  if (host.exists(file.path)) {
    if (host.readText(file.path) === file.text) {
      record(found(key));
      return false;
    }
    if (!changedByApply(context.whatApplyChanged, key)) {
      throw new Error(
        `${file.path} exists, and apply didn't write it. Move it away, ` +
          "then run apply again.",
      );
    }
  }
  await change("nginx", `write ${file.path}`, () => {
    const folders = foldersToMake(host, path.dirname(file.path));
    recordFoldersMade(record, "nginxFileFolder", folders);
    host.writeRootFile(file.path, file.text, file.mode);
    record(made(key));
  });
  return true;
}

/**
 * Makes nginx's log folder again when it's gone, as nginx.org's package
 * makes it, since `nginx -t` can't open the logs without it. The folder
 * is the package's, which purging the package removes, so apply doesn't
 * record it.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function makeLogFolder(context) {
  const { host, change } = context;
  if (host.exists(NGINX_LOG_DIR)) {
    return;
  }
  await change("nginx", `make ${NGINX_LOG_DIR}`, () =>
    host.makeRootDir(NGINX_LOG_DIR, NGINX_LOG_DIR_MODE),
  );
}

/**
 * Records each folder of nginx's certificates. `nginx -t` has just made
 * any that were missing, so each is recorded as found, and undo-apply
 * leaves it. A purge of nginx removes them at the shipped paths. Root
 * may own a folder's parent, so root looks.
 * @param {object} context  The run.
 */
function recordCertificateFolders(context) {
  const { host, settings, record, staging } = context;
  const production = ["acmeStateFolder", settings.acmeStatePath];
  const folders =
    staging === true
      ? [production, ["acmeStagingStateFolder", settings.acmeStagingStatePath]]
      : [production];
  const asRoot = rootLooks(host);
  for (const [name, folder] of folders) {
    const there = asRoot.exists(folder);
    const key = `${name}:${folder}`;
    record(there === true ? found(key) : made(key));
  }
}

/**
 * Decides how nginx takes up the stage's files: a start when it's
 * stopped, a restart when the drop-in changed or it doesn't answer, a
 * reload when another file changed, and nothing otherwise.
 * @param {boolean} running  Whether nginx is active.
 * @param {boolean} answering  Whether its gate page says ok.
 * @param {Set<string>} wrote  The settings' names of the files written.
 * @returns {""|"start"|"restart"|"reload"}
 */
function startHow(running, answering, wrote) {
  if (running === false) {
    return "start";
  }
  if (wrote.has("systemdDropInFile") || answering === false) {
    return "restart";
  }
  return wrote.size > 0 ? "reload" : "";
}

/**
 * Reads the stage's files as they are before it writes, so a
 * configuration nginx refuses can be taken back.
 * @param {object} host  The host.
 * @param {{name: string, path: string}[]} files  The stage's files.
 * @returns {Map<string, string|null>} Each file's text, by its setting's
 *   name, or null when it isn't there.
 */
function textsBefore(host, files) {
  const texts = new Map();
  for (const file of files) {
    const text = host.exists(file.path) ? host.readText(file.path) : null;
    texts.set(file.name, text);
  }
  return texts;
}

/**
 * Keeps what nginx refused in the tool's error log, with why, for the
 * operator to read. The files hold no key and no other secret. It makes
 * the tool's logs folder when it's missing, as on a first install, and
 * records it, so undo-apply removes it.
 * @param {object} context  The run.
 * @param {string} reason  What nginx said.
 * @param {{path: string, text: string}[]} takenBack  The files this run
 *   wrote, which are now put back.
 */
function keepRefused(context, reason, takenBack) {
  const { host, paths, record } = context;
  if (!host.exists(paths.logsDir)) {
    record(made(`toolLogsFolder:${paths.logsDir}`));
    host.makeUserDir(paths.logsDir, 0o755);
  }
  const when = new Date(host.now()).toISOString();
  const lines = [
    `${when} apply: nginx refused its configuration.`,
    `nginx said: ${reason}`,
  ];
  for (const file of takenBack) {
    lines.push(
      `apply put back ${file.path} as it was. What it had written there:`,
      file.text,
    );
  }
  const entry = `${lines.join("\n")}\n\n`;
  const earlier = host.exists(paths.errorLogPath)
    ? host.readText(paths.errorLogPath)
    : "";
  const text = `${earlier}${entry}`;
  host.writeUserFile(paths.errorLogPath, text, 0o644);
}

/**
 * Takes back a configuration nginx refused. Of the stage's three files,
 * the key check, nginx.conf and the drop-in, each that this run wrote
 * goes back as it was, or goes when the run made it new, so the files on
 * disk match what the running nginx and systemd run. nginx's list of the
 * api keys' hashes stays, even when this run's fourth stage wrote it. The
 * list holds the hashes in the api keys' file, which stays too, and a
 * running nginx already reads the list, since that stage reloads nginx
 * right after writing it. Then the function keeps what was refused in the
 * tool's error log, and stops the run.
 * @param {object} context  The run.
 * @param {{stderr: string}} tested  nginx -t's answer.
 * @param {{files: object[], before: Map<string, string|null>,
 *   wrote: Set<string>}} written  The stage's files, their texts from
 *   before the run, and the names of the files it wrote.
 * @throws {Error} Always. When a file the run wrote has no text from
 *   before the run, which is a mistake in the tool, it names that file,
 *   since writing nothing back would empty it. Otherwise it names nginx's
 *   reason and the error log, since nginx can't start or reload on a
 *   configuration it won't load.
 */
function takeBackRefused(context, tested, written) {
  const { host, paths } = context;
  const reason = tested.stderr.trim();
  const takenBack = written.files.filter((file) =>
    written.wrote.has(file.name),
  );
  for (const file of takenBack) {
    const old = written.before.get(file.name);
    if (old === undefined) {
      throw new Error(
        `apply has no text of ${file.path} from before the run, so it ` +
          "can't put the file back.",
      );
    }
    if (old === null) {
      host.removeRootFile(file.path);
    } else {
      host.writeRootFile(file.path, old, file.mode);
    }
  }
  keepRefused(context, reason, takenBack);
  const putBack =
    takenBack.length > 0 ? "apply put the files back as they were. " : "";
  throw new Error(
    `nginx refused the configuration: ${reason}\n${putBack}What nginx ` +
      `refused, and why, is in ${paths.errorLogPath}.`,
  );
}

/**
 * Tests the configuration, reloads systemd, records nginx's service as
 * apply set it, and starts, restarts or reloads nginx. A configuration
 * nginx refuses is taken back first.
 * @param {object} context  The run.
 * @param {"start"|"restart"|"reload"} how  How nginx takes up its files.
 * @param {{files: object[], before: Map<string, string|null>,
 *   wrote: Set<string>}} written  What the stage wrote, for a refusal to
 *   take back.
 */
function startNginx(context, how, written) {
  const { host, settings, record } = context;
  const tested = host.sudo("nginx", ["-t", "-c", settings.nginxConfigPath]);
  if (tested.status !== 0) {
    takeBackRefused(context, tested, written);
  }
  /*-
   * Only after the test, so systemd never reads a drop-in that a refusal
   * then puts back.
   */
  systemctl(host, ["daemon-reload"]);
  recordCertificateFolders(context);
  const unitState = unitFileState(host, NGINX_UNIT);
  systemctl(host, ["unmask", NGINX_UNIT]);
  record({
    key: "nginxServiceMasked",
    oldValue: unitState === "masked",
    newValue: false,
  });
  systemctl(host, ["enable", NGINX_UNIT]);
  record({
    key: "nginxServiceEnabled",
    oldValue: unitState === "enabled",
    newValue: true,
  });
  systemctl(host, [how, NGINX_UNIT]);
}

/**
 * Runs the stage.
 * @param {object} context  The run, with the api key the fourth stage
 *   made, or "" when it made none.
 * @returns {Promise<void>}
 * @throws {Error} When the fourth stage handed on something that's
 *   neither "" nor an api key, nginx refuses the configuration (once the
 *   files the stage wrote are put back), the certificate doesn't arrive
 *   in time, or the request path fails a check, since the later stages
 *   would then hand out a url that doesn't work.
 */
export async function configureNginx(context) {
  const { host, settings, facts, change, log } = context;
  const key = checkedKey(context.key);
  const files = nginxFiles(context);
  const before = textsBefore(host, files);
  const wrote = new Set();
  for (const file of files) {
    if ((await writeFile(context, file)) === true) {
      wrote.add(file.name);
    }
  }
  await makeLogFolder(context);
  const setup = {
    hostname: settings.hostname,
    publicIp: facts.publicIp,
    rpcPort: facts.rpcPort,
    staging: context.staging,
  };
  /*-
   * Set before the early return below. A run after a start that failed
   * finds nginx answering with nothing to change, and must still record
   * it.
   */
  context.state.setup = setup;
  const target = targetOf(setup, settings);
  const running = unitActiveState(host, NGINX_UNIT) === "active";
  const answering = running === true && (await readGate(host, target)) === "ok";
  const how = startHow(running, answering, wrote);
  if (how === "" && key === "") {
    log.info("nginx", "nginx runs, with nothing changed.");
    return;
  }
  const what =
    how === ""
      ? "check, with the new api key, that nginx lets it through and refuses requests without a key or with a random one"
      : `test the configuration, then ${how} nginx`;
  await change("nginx", what, async () => {
    if (how !== "") {
      startNginx(context, how, { files, before, wrote });
    }
    log.info("nginx", "Waiting for the certificate.");
    const waitMs = settings.certificateWaitSeconds * 1000;
    const gate = await waitForGate(host, target, waitMs, settings.gatePollMs);
    if (gate !== "ok") {
      throw new Error(
        `No certificate in time: ${GATE_PAGE_NAME} says ${gate}. ` +
          `nginx writes why in ${NGINX_LOG_DIR}/error.log, and ` +
          "x1-validator-private-rpc/docs/manual-domain-setup.md lists the " +
          "usual causes.",
      );
    }
    /*-
     * A reload takes a moment, longer with many keys, while nginx still
     * checks against its old list. So the checks are asked again until
     * they pass, or the time runs out.
     */
    const { answer: problems } = await pollUntil(
      () => requestPathProblems(host, target, key),
      (found) => found.length === 0,
      {
        timeoutMs: waitMs,
        intervalMs: settings.gatePollMs,
        now: host.now,
        sleep: host.sleep,
      },
    );
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }
    const keyed = key === "" ? "" : "the new api key got through, and ";
    log.info(
      "nginx",
      `Test requests from this machine through nginx: ${keyed}requests without a key or with a random one got 403.`,
    );
  });
}
