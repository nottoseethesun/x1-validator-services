/**
 * @file scripts/_lxd-nginx-checks.js
 * @description
 * The LXD system test's checks of nginx's logs and of its own /dev, in
 * its apply phase.
 *
 * The logs must hold no key, wherever a client put it, and show `<key>`
 * in its place, since the njs mask's errors would go nowhere. Their files
 * keep the mode nginx.org's package gives them, so only root, nginx and
 * the adm group can read them.
 *
 * nginx runs with a /dev of its own, read-only, so its master can't hand
 * the machine's /dev/null to the nginx account when it reopens its logs.
 * In the container, /dev/null is the host's, which shows as nobody's, so
 * the check is of nginx's /dev, not of /dev/null's owner. Then it has
 * nginx reopen its logs, as logrotate does each night, and checks the key
 * still works.
 *
 * nginx can't open its logs once their folder is gone, so the drop-in
 * makes it before each start, and the key commands before their reload.
 * The check deletes it and restarts nginx, then deletes it again for the
 * add-api-key check that follows.
 *
 * undo-apply removes no package, so it must leave nginx installed,
 * stopped and masked, and say how to purge it. The test then purges it,
 * as the operator may, and runs undo-apply again. Never on a validator.
 */

import {
  NGINX_LOG_DIR,
  NGINX_PACKAGES,
  NGINX_UNIT,
} from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { answersWith } from "./_lxd-api-key-checks.js";
import { AFFIRM_DISCLAIMER, asRoot, asRootCaptured, mustPass } from "./_lxd.js";

/**
 * Sends requests with the key where the logs' mask must still find it:
 * after a doubled slash, a character short, in the query string alone,
 * and in the query string as well as the path. Then it checks that
 * nginx's logs hold no key but show `<key>` in its place, and that their
 * files have the mode nginx.org's package gives them.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {string} key  The api key.
 */
export function checkLogs(guest, key) {
  const { name } = guest;
  const urlPaths = [
    `//${key}/health`,
    `/${key.slice(0, -1)}/health`,
    `/?api-key=${key}`,
    `/${key}/health?api-key=${key}`,
  ];
  for (const urlPath of urlPaths) {
    const asked = asRootCaptured(name, [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "--cacert",
      guest.ca,
      `https://${guest.hostname}${urlPath}`,
    ]);
    mustPass(asked.status, "Asking nginx with a mistyped url");
  }
  const logDir = NGINX_LOG_DIR;
  const shortKey = key.slice(0, -1);
  const leaked = asRootCaptured(name, ["grep", "-rl", shortKey, logDir]);
  guest.expect(
    "nginx's logs hold no key, even from a mistyped url or the query string",
    leaked.stdout.trim() === "",
  );
  const masked = asRootCaptured(name, [
    "grep",
    "-rlF",
    "?api-key=<key>",
    logDir,
  ]);
  guest.expect(
    "nginx's access log shows <key> where the query string held the key",
    masked.stdout.trim() !== "",
  );
  const listed = asRootCaptured(name, ["find", logDir, "-type", "f"]);
  const logs = listed.stdout.split("\n").filter((line) => line !== "");
  const modes = logs.map((log) =>
    asRootCaptured(name, ["stat", "-c", "%a %U %G", log]).stdout.trim(),
  );
  guest.expect(
    "nginx writes its logs, with the mode nginx.org's package gives them: 640, owner nginx, group adm",
    logs.length > 0 && modes.every((mode) => mode === "640 nginx adm"),
  );
}

/**
 * Finds the mount a process in the container sees at /dev: the last one
 * listed, which lies on top.
 * @param {string} name  The container.
 * @param {string} pid  The process.
 * @returns {{id: string, options: string[]}} The mount's number and its
 *   options, or "" and none when the process has none there.
 */
function devMountOf(name, pid) {
  const listed = asRootCaptured(name, ["cat", `/proc/${pid}/mountinfo`]);
  const mounts = listed.stdout
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields[4] === "/dev");
  const top = mounts[mounts.length - 1];
  if (top === undefined || top === null) {
    return { id: "", options: [] };
  }
  return { id: top[0], options: top[5].split(",") };
}

/**
 * Checks that nginx's /dev is its own and read-only, and that the key
 * still works once nginx reopens its logs.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {string} key  The api key.
 */
export function checkOwnDev(guest, key) {
  const { name } = guest;
  const shown = asRootCaptured(name, [
    "systemctl",
    "show",
    "--property=MainPID",
    "--value",
    NGINX_UNIT,
  ]);
  const nginxDev = devMountOf(name, shown.stdout.trim());
  const machineDev = devMountOf(name, "1");
  guest.expect(
    "nginx runs with a /dev of its own, read-only",
    nginxDev.id !== "" &&
      nginxDev.id !== machineDev.id &&
      nginxDev.options.includes("ro"),
  );
  const reopened = asRoot(name, [
    "systemctl",
    "kill",
    "--kill-whom=main",
    "--signal=USR1",
    NGINX_UNIT,
  ]);
  mustPass(reopened, "Having nginx reopen its logs");
  guest.expect(
    "after nginx reopens its logs, the key still works",
    answersWith(guest, key, "200"),
  );
}

/**
 * Deletes nginx's log folder and restarts nginx. The drop-in must make
 * the folder again, as nginx.org's package makes it, root's with mode
 * 755, and nginx must start and take the key. Then it deletes the folder
 * again, so the add-api-key check that follows fails unless its reload
 * makes it.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {string} key  The api key.
 */
export function checkLogFolderComesBack(guest, key) {
  const { name } = guest;
  const folder = NGINX_LOG_DIR;
  mustPass(asRoot(name, ["rm", "-rf", "--", folder]), "Deleting nginx's logs");
  const restarted = asRoot(name, ["systemctl", "restart", NGINX_UNIT]);
  const made = asRootCaptured(name, ["stat", "-c", "%a %U %G", folder]);
  guest.expect(
    "with its log folder deleted, nginx starts again, the drop-in makes the folder as nginx.org's package does, root's with mode 755, and the key works",
    restarted === 0 &&
      made.stdout.trim() === "755 root root" &&
      answersWith(guest, key, "200"),
  );
  const again = asRoot(name, ["rm", "-rf", "--", folder]);
  mustPass(again, "Deleting nginx's logs again, for add-api-key's reload");
}

/**
 * Checks that undo-apply left nginx installed, stopped and masked, since
 * it removes no package, and said how to purge it.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {string} output  What undo-apply printed.
 */
export function checkNginxStays(guest, output) {
  const { name } = guest;
  const status = asRootCaptured(name, [
    "dpkg-query",
    "--show",
    "--showformat=${Status}",
    "nginx",
  ]).stdout.trim();
  const unit = (verb) =>
    asRootCaptured(name, ["systemctl", verb, NGINX_UNIT]).stdout.trim();
  guest.expect(
    "undo-apply leaves nginx installed, stopped and masked, and says how to purge it",
    status === "install ok installed" &&
      unit("is-active") !== "active" &&
      unit("is-enabled") === "masked" &&
      output.includes(`sudo apt purge ${NGINX_PACKAGES.join(" ")}`),
  );
}

/**
 * Plays the operator's own purge of nginx and its modules, which
 * undo-apply leaves to them, then runs undo-apply again, which takes back
 * what stayed with nginx.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @returns {Promise<boolean>} Whether both went through.
 */
export async function purgeThenUndo(guest) {
  const purged = asRoot(guest.name, [
    "env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt",
    "-o",
    "Apt::Cmd::Disable-Script-Warning=true",
    "purge",
    "--yes",
    ...NGINX_PACKAGES,
  ]);
  const undone = await guest.answer(`node ${guest.cli} undo-apply`, [
    AFFIRM_DISCLAIMER,
  ]);
  return purged === 0 && undone.code === 0;
}
