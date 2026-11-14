/**
 * @file x1-validator-private-rpc/src/cli/apply-install.js
 * @description
 * apply's second and third stages. The second installs nginx and its
 * njs and ACME modules from nginx.org's apt repository, with nginx.service
 * masked first, so the package's default site never runs. It adds the
 * repository with the code validate-nginx-upgrade uses, which trusts only
 * nginx.org's two pinned keys. The third opens tcp port 443 in ufw. A rule
 * ufw holds for that port already stays as it is, whether ufw is on or
 * off, and the stage changes nothing else there.
 *
 * Each stage skips work that is already done, so a second apply changes
 * nothing. Each records the settings it changes, or finds as it needs
 * them, in apply's record. The second records each change just before
 * it's made, since apt runs for minutes, and a run that dies part way
 * must still leave the change on record.
 */

import { installPackages, installedVersion } from "../lib/apt.js";
import { mustSucceed } from "../lib/command-result.js";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  NGINX_PACKAGES,
  NGINX_UNIT,
} from "../lib/nginx-org.js";
import { addNginxRepository } from "../lib/nginx-repo.js";
import { systemctl, unitFileState } from "../lib/systemd.js";
import { found, made } from "./what-apply-changed.js";

/** The firewall rule apply adds. */
export const HTTPS_RULE = "443/tcp";

/** The actions a ufw rule can take. */
const UFW_ACTIONS = ["allow", "limit", "deny", "reject"];

/** The log settings a ufw rule can carry, written before its port. */
const UFW_LOG_TYPES = ["log", "log-all"];

/** nginx.org's repository files, with their settings' names. */
const REPOSITORY_FILES = new Map([
  [NGINX_KEYRING_PATH, "nginxAptKeyring"],
  [NGINX_APT_SOURCE_PATH, "nginxAptSource"],
  [NGINX_APT_PIN_PATH, "nginxAptPin"],
]);

/**
 * Names a package's setting in apply's record.
 * @param {string} name  The package, such as `nginx`.
 * @returns {string}
 */
export function packageKey(name) {
  return `nginxPackage:${name}`;
}

/**
 * Names a repository file's setting in apply's record.
 * @param {string} filePath  The file.
 * @returns {string}
 */
function repositoryKey(filePath) {
  return `${REPOSITORY_FILES.get(filePath)}:${filePath}`;
}

/**
 * Finds ufw's rule for tcp port 443 among the rules the ufw command
 * added, which ufw lists even while it's off. ufw takes any rule for
 * that port as the same rule, whatever its action, log setting or
 * comment, so `ufw allow 443/tcp` would overwrite it.
 * @param {object} host  The host.
 * @returns {{line: string, action: string}|null} The rule as ufw prints
 *   it, and its action; null when there is none.
 */
export function httpsRuleOf(host) {
  const listed = host.sudo("ufw", ["show", "added"]);
  const added = mustSucceed(listed, "Reading ufw's rules").stdout;
  for (const line of added.split("\n")) {
    const [command, action, ...rest] = line.trim().split(" ");
    const logged = UFW_LOG_TYPES.includes(rest[0]);
    const [port, ...tail] = logged ? rest.slice(1) : rest;
    const sameRule =
      command === "ufw" &&
      UFW_ACTIONS.includes(action) &&
      port === HTTPS_RULE &&
      (tail.length === 0 || tail[0] === "comment");
    if (sameRule) {
      return { line: line.trim(), action };
    }
  }
  return null;
}

/**
 * Explains why apply can't go on when ufw's rule closes port 443.
 * @param {{line: string, action: string}|null} rule  ufw's rule for the
 *   port, or null when there is none.
 * @returns {string|null} The problem, or null when there is none.
 */
export function httpsRuleProblem(rule) {
  const closes =
    rule !== undefined &&
    rule !== null &&
    (rule.action === "deny" || rule.action === "reject");
  return closes
    ? `ufw's rule "${rule.line}" closes tcp port 443, which nginx needs. ` +
        "apply won't change your rule. Remove it, or make it allow the " +
        "port, then run apply again."
    : null;
}

/**
 * Installs nginx from nginx.org, unless apply installed it before.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 */
export async function installNginx(context) {
  const { host, record, change, facts, settings } = context;
  if (installedVersion(host, "nginx") !== null) {
    context.log.info("nginx", "nginx is installed already.");
    return;
  }
  const accountExisted = host.run("getent", ["passwd", "nginx"]).status === 0;
  const wasMasked = unitFileState(host, NGINX_UNIT) === "masked";
  await change(
    "nginx",
    `mask ${NGINX_UNIT}, so the package's default site never runs`,
    () => {
      systemctl(host, ["mask", NGINX_UNIT]);
      record({
        key: "nginxServiceMasked",
        oldValue: wasMasked,
        newValue: true,
      });
    },
  );
  await change(
    "nginx",
    "add nginx.org's apt repository, after checking its signing key",
    async () => {
      for (const filePath of REPOSITORY_FILES.keys()) {
        if (host.exists(filePath)) {
          record(found(repositoryKey(filePath)));
        }
      }
      await addNginxRepository(host, {
        codename: facts.codename,
        timeoutMs: settings.requestTimeoutSeconds * 1000,
        beforeWrite: (filePath) => record(made(repositoryKey(filePath))),
      });
    },
  );
  await change("nginx", `install ${NGINX_PACKAGES.join(", ")}`, async () => {
    /*-
     * The account goes on record first, so undo-apply, which goes newest
     * first, removes it only after the packages. dpkg holds no module
     * without nginx, so none of the packages was there before.
     */
    record(accountExisted ? found("nginxAccount") : made("nginxAccount"));
    for (const name of NGINX_PACKAGES) {
      record(made(packageKey(name)));
    }
    await installPackages(host, NGINX_PACKAGES);
  });
}

/**
 * Opens tcp port 443 in ufw, unless ufw holds a rule for it already.
 * @param {object} context  The run.
 * @returns {Promise<void>}
 * @throws {Error} When ufw's rule closes the port, since changing it
 *   would change the operator's rule.
 */
export async function openFirewall(context) {
  const { host, record, change } = context;
  const key = `firewallRule:${HTTPS_RULE}`;
  const rule = httpsRuleOf(host);
  const problem = httpsRuleProblem(rule);
  if (problem !== null) {
    throw new Error(problem);
  }
  if (rule !== undefined && rule !== null) {
    context.log.info(
      "firewall",
      `ufw has the rule "${rule.line}" already, and it stays as it is.`,
    );
    record(found(key));
    return;
  }
  await change("firewall", `run ufw allow ${HTTPS_RULE}`, () => {
    const allowedNow = host.sudo("ufw", ["allow", HTTPS_RULE]);
    mustSucceed(allowedNow, `Allowing ${HTTPS_RULE}`);
    record(made(key));
  });
}
