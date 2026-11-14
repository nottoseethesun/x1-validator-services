/**
 * @file x1-validator-private-rpc/src/cli/apply-nginx.js
 * @description
 * apply's fifth stage: nginx's own files, then nginx itself. It writes
 * the key check, the configuration, the start wrapper, the systemd
 * drop-in and the logrotate rule, each only when it's missing or
 * differs, and refuses to write over a file apply didn't write. Then it
 * reloads systemd and has nginx test the configuration, which also
 * fails when the public address isn't on the machine. The fourth stage
 * already brings an existing drop-in in line with the saved password,
 * through matchDropIn, so a stop between the two stages leaves systemd
 * expecting nothing that's gone.
 *
 * nginx then starts with the key, handed over as unlock does, unless it
 * runs unlocked already with nothing changed and the key isn't new. The
 * gate page can't tell which key nginx holds, so a key the fourth stage
 * made always goes to nginx. The stage waits for the certificate, and
 * checks the whole request path from the server: the gate page says
 * unlocked, the keyed path reaches the rpc, and a path without the key
 * gets a 403. Before the first start it records the key's hand-off
 * folder, so undo-apply can remove it, and the certificates' folders.
 * `nginx -t` makes those first, so apply records them as found. Purging
 * nginx removes them at the shipped paths.
 */

import path from "node:path";
import { mustSucceed } from "../lib/command-result.js";
import { foldersToMake } from "../lib/folders-to-make.js";
import { NGINX_UNIT } from "../lib/nginx-org.js";
import {
  renderDropIn,
  renderLogrotateRule,
  renderStartWrapper,
} from "../lib/render-host-files.js";
import { systemctl, unitFileState } from "../lib/systemd.js";
import {
  handKeyToNginx,
  readGate,
  requestPathProblems,
  targetOf,
  waitForUnlocked,
} from "./nginx-gate.js";
import { renderNginxConfig } from "./render-nginx.js";
import { changedByApply, found, made } from "./what-apply-changed.js";

/**
 * Describes the systemd drop-in for nginx.service: a start through the
 * start wrapper, and the saved password when there is one.
 * @param {object} settings  The tool's settings.
 * @param {boolean} saved  Whether the password is saved.
 * @returns {{name: string, path: string, text: string, mode: string}}
 */
function dropInFile(settings, saved) {
  return {
    name: "systemdDropInFile",
    path: settings.systemdDropInPath,
    text: renderDropIn({
      startWrapperPath: settings.startWrapperPath,
      passwordCredentialPath:
        saved === true ? settings.passwordCredentialPath : null,
    }),
    mode: "0644",
  };
}

/**
 * Lists the files the stage writes, with their settings' names, their
 * text and their mode.
 * @param {object} context  The run.
 * @param {boolean} saved  Whether the password is saved.
 * @returns {{name: string, path: string, text: string, mode: string}[]}
 */
function nginxFiles(context, saved) {
  const { host, settings, facts, paths, staging } = context;
  const keyCheck = host.readText(paths.njsModuleSource);
  const validatorUser = host.userName();
  const nodeBin = host.nodePath();
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
      name: "startWrapperFile",
      path: settings.startWrapperPath,
      text: renderStartWrapper({
        validatorUser,
        nodeBin,
        toolCli: paths.toolCli,
        nginxConfigPath: settings.nginxConfigPath,
        keyHandOffPath: settings.keyHandOffPath,
      }),
      mode: "0755",
    },
    dropInFile(settings, saved),
    {
      name: "logrotateRuleFile",
      path: settings.logrotateRulePath,
      text: renderLogrotateRule(settings),
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
 * @throws {Error} When the file exists and apply didn't write it, since
 *   writing over it would lose a file someone else made.
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
    for (const folder of folders) {
      record(made(`nginxFileFolder:${folder}`));
    }
    host.writeRootFile(file.path, file.text, file.mode);
    record(made(key));
  });
  return true;
}

/**
 * Brings the systemd drop-in in line with whether the password is saved,
 * and has systemd read it again, when an earlier run wrote it. systemd
 * reads a drop-in only then, or at boot. The fourth stage calls this as
 * it saves the password, once the file is there, and as it removes it,
 * before the file goes. So apply never stops while systemd expects a
 * saved password that's gone. With no drop-in yet, nginx has never
 * started through the tool, and this stage writes one.
 * @param {object} context  The run.
 * @param {boolean} saved  Whether the password is saved.
 * @returns {Promise<void>}
 */
export async function matchDropIn(context, saved) {
  const { host, settings } = context;
  if (!host.exists(settings.systemdDropInPath)) {
    return;
  }
  const wrote = await writeFile(context, dropInFile(settings, saved));
  if (wrote === true) {
    systemctl(host, ["daemon-reload"]);
  }
}

/**
 * Makes nginx's log folder when it's missing, open to root and nginx's
 * group alone. So no other account can read a log, whatever the log
 * file's own mode, while nginx's workers can still reopen their logs
 * there after each rotation.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
async function makeLogFolder(context) {
  const { host, record, change, settings } = context;
  const folder = settings.nginxLogDir;
  const key = `nginxLogFolder:${folder}`;
  if (host.exists(folder)) {
    record(found(key));
    return;
  }
  await change("nginx", `make ${folder}`, () => {
    host.makeRootDir(folder, "0750", "nginx");
    record(made(key));
  });
}

/**
 * Records each folder of nginx's certificates. `nginx -t` has just made
 * any that were missing, so each is recorded as found, and undo-apply
 * leaves it. Purging nginx removes them at the shipped paths. Root may
 * own a folder's parent, so root looks.
 * @param {object} context  The run.
 */
function recordCertificateFolders(context) {
  const { host, settings, record, staging } = context;
  const production = ["acmeStateFolder", settings.acmeStatePath];
  const folders =
    staging === true
      ? [production, ["acmeStagingStateFolder", settings.acmeStagingStatePath]]
      : [production];
  for (const [name, folder] of folders) {
    const looked = host.sudo("test", ["-e", folder]);
    const key = `${name}:${folder}`;
    record(looked.status === 0 ? found(key) : made(key));
  }
}

/**
 * Records the key's hand-off folder, before the hand-over makes it when
 * it's missing, so undo-apply removes it only when apply made it.
 * @param {object} context  The run.
 */
function recordHandOffFolder(context) {
  const { host, settings, record } = context;
  const folder = path.dirname(settings.keyHandOffPath);
  const key = `keyHandOffFolder:${folder}`;
  const there = host.exists(folder);
  record(there === true ? found(key) : made(key));
}

/**
 * Runs the stage.
 * @param {object} context  The run, with the key and whether the
 *   password is saved from the fourth stage.
 * @returns {Promise<void>}
 * @throws {Error} When nginx refuses the configuration, the certificate
 *   doesn't arrive in time, or the request path fails a check, since
 *   the later stages would then hand out a url that doesn't work.
 */
export async function configureNginx(context) {
  const { host, settings, facts, record, change, log } = context;
  let changed = false;
  for (const file of nginxFiles(context, context.saved)) {
    const wrote = await writeFile(context, file);
    if (wrote === true) {
      changed = true;
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
   * finds nginx unlocked with nothing to change, and must still record it.
   */
  context.state.setup = setup;
  const target = targetOf(setup, settings);
  const running = host
    .run("systemctl", ["is-active", NGINX_UNIT])
    .stdout.trim();
  const unlocked =
    running === "active" && (await readGate(host, target)) === "unlocked";
  if (changed === false && unlocked === true && context.keyIsNew === false) {
    log.info("nginx", "nginx runs unlocked, with nothing changed.");
    return;
  }
  await change(
    "nginx",
    "test the configuration, then start nginx with the key",
    async () => {
      systemctl(host, ["daemon-reload"]);
      const tested = host.sudo("nginx", ["-t", "-c", settings.nginxConfigPath]);
      mustSucceed(tested, "Testing nginx's configuration");
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
      recordHandOffFolder(context);
      handKeyToNginx(host, settings.keyHandOffPath, context.key);
      context.keyWaitsForNginx = false;
      log.info("nginx", "Waiting for the certificate.");
      const gate = await waitForUnlocked(
        host,
        target,
        settings.certificateWaitSeconds * 1000,
        settings.gatePollMs,
      );
      const problems =
        gate === "unlocked"
          ? await requestPathProblems(host, target, context.key)
          : [`No certificate, or no key, in time: the gate page says ${gate}.`];
      if (problems.length > 0) {
        throw new Error(problems.join("\n"));
      }
      log.info("nginx", "The request path checks out from the server.");
    },
  );
}
