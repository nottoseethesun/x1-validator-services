/**
 * @file scripts/_lxd-nginx-checks.js
 * @description
 * The LXD system test's checks of nginx's logs and of its own /dev, in
 * its apply phase.
 *
 * The logs must hold no key, wherever a client put it, and show `<key>`
 * in its place, since the njs mask's errors would go nowhere. No other
 * account may read them.
 *
 * nginx runs with a /dev of its own, read-only, so its master can't hand
 * the machine's /dev/null to the nginx account when it reopens its logs.
 * In the container, /dev/null is the host's, which shows as nobody's, so
 * the check is of nginx's /dev, not of /dev/null's owner. Then it has
 * nginx reopen its logs, as logrotate does each night, and checks the key
 * still works. Never on a validator.
 */

import { NGINX_UNIT } from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { answersWith } from "./_lxd-api-key-checks.js";
import { asRoot, asRootCaptured, asUserCaptured, mustPass } from "./_lxd.js";

/**
 * Sends requests with the key where the logs' mask must still find it:
 * after a doubled slash, a character short, in the query string alone,
 * and in the query string as well as the path. Then it checks that
 * nginx's logs hold no key but show `<key>` in its place, and that no
 * other account can read them.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {string} key  The api key.
 * @param {object} settings  The settings the tool loads there.
 */
export function checkLogs(guest, key, settings) {
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
  const logDir = settings.nginxLogDir;
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
  // As the validator's account, with all its groups, adm among them.
  const readable = logs.filter(
    (log) => asUserCaptured(name, ["cat", log]).status === 0,
  );
  guest.expect(
    "nginx writes its logs, and the validator's account can't read them",
    logs.length > 0 && readable.length === 0,
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
