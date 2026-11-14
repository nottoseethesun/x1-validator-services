/**
 * @file x1-validator-private-rpc/src/cli/nginx-gate.js
 * @description
 * Hands the api key to nginx, and checks the request path from the
 * server itself.
 *
 * The hand-over is the one unlock makes. Through sudo, the key goes to
 * the memory-only hand-off file, mode 0600, in a root-only folder that
 * is made when missing, as it is after every reboot. Then nginx restarts,
 * and its start wrapper reads the file and deletes it at once. The key
 * is never an argument of a command: sudo receives it on standard input.
 *
 * The checks reach nginx on the public address, with the tls server
 * name and the Host header set to the hostname, so they work whatever
 * the dns record says. With Let's Encrypt's staging service they trust
 * the staging roots the tool ships; otherwise Node.js's usual roots.
 */

import fs from "node:fs";
import path from "node:path";
import { mustSucceed } from "../lib/command-result.js";
import { GATE_PAGE_PATH } from "../lib/gate-page.js";
import { NGINX_UNIT } from "../lib/nginx-org.js";
import { pollUntil } from "../lib/poll.js";
import { systemctl } from "../lib/systemd.js";

/**
 * Reads Let's Encrypt's staging roots, which the tool ships.
 * @returns {string} The roots, in pem.
 */
export function stagingRoots() {
  const roots = new URL(
    "../../certs/letsencrypt-staging-roots.pem",
    import.meta.url,
  );
  return fs.readFileSync(roots, "utf8");
}

/**
 * @typedef {object} Target
 * @property {string} address  The public address.
 * @property {string} hostname  The rpc's hostname.
 * @property {number} timeoutMs  How long to wait for each answer.
 * @property {string} [ca]  The roots to trust; Node.js's own when absent.
 */

/**
 * Makes the target of the checks for what apply set up.
 * @param {{hostname: string, publicIp: string, staging: boolean}} setup
 *   What apply set nginx up with.
 * @param {object} settings  The tool's settings.
 * @returns {Target}
 */
export function targetOf(setup, settings) {
  return {
    address: setup.publicIp,
    hostname: setup.hostname,
    timeoutMs: settings.requestTimeoutSeconds * 1000,
    ...(setup.staging ? { ca: stagingRoots() } : {}),
  };
}

/**
 * Asks nginx for one path, under the hostname.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @param {string} urlPath  The path.
 * @returns {Promise<import("../lib/host.js").TlsAnswer>}
 */
export function askNginx(host, target, urlPath) {
  return host.tlsGet({ ...target, port: 443, path: urlPath });
}

/**
 * Reads the gate page, which says whether nginx holds a usable key.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @returns {Promise<string>} `unlocked`, `locked`, or what came instead.
 */
export async function readGate(host, target) {
  try {
    const answer = await askNginx(host, target, GATE_PAGE_PATH);
    return answer.status === 200 ? answer.body.trim() : `http ${answer.status}`;
  } catch (error) {
    return `no answer (${error.message})`;
  }
}

/**
 * Hands the api key to nginx and restarts it. The hand-off folder is
 * made, for root alone, only when it's missing, so a folder that was
 * there keeps its own mode.
 * @param {object} host  The host.
 * @param {string} keyHandOffPath  The memory-only hand-off file.
 * @param {string} key  The api key.
 */
export function handKeyToNginx(host, keyHandOffPath, key) {
  const folder = path.dirname(keyHandOffPath);
  if (!host.exists(folder)) {
    const made = host.sudo("install", ["-d", "-m", "0700", "--", folder]);
    mustSucceed(made, `Creating ${folder}`);
  }
  const written = host.sudo(
    "sh",
    ["-c", 'umask 077 && cat > "$1"', "hand-off", keyHandOffPath],
    { input: key },
  );
  mustSucceed(written, `Writing ${keyHandOffPath}`);
  systemctl(host, ["restart", NGINX_UNIT]);
}

/**
 * Waits until nginx answers the gate page with `unlocked`: its
 * certificate is in place and checks out, and it holds the key.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @param {number} waitMs  How long to wait in all.
 * @param {number} pollMs  How long to wait between two looks.
 * @returns {Promise<string>} The gate page's last answer.
 */
export async function waitForUnlocked(host, target, waitMs, pollMs) {
  const { answer } = await pollUntil(
    () => readGate(host, target),
    (gate) => gate === "unlocked",
    {
      timeoutMs: waitMs,
      intervalMs: pollMs,
      now: host.now,
      sleep: host.sleep,
    },
  );
  return answer;
}

/**
 * Checks the whole request path from the server: the gate page says
 * unlocked, the keyed path reaches the rpc's health check, and a path
 * without the key gets a 403.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @param {string} key  The api key.
 * @returns {Promise<string[]>} What failed; nothing when all passed.
 */
export async function requestPathProblems(host, target, key) {
  const problems = [];
  const gate = await readGate(host, target);
  if (gate !== "unlocked") {
    problems.push(`The gate page says ${gate}, not unlocked.`);
  }
  const answer = (urlPath) =>
    askNginx(host, target, urlPath).catch((error) => ({
      status: 0,
      body: error.message,
    }));
  const health = await answer(`/${key}/health`);
  if (health.status !== 200 || health.body.trim() !== "ok") {
    problems.push(
      `The keyed path's health check answered ${health.status}: ${health.body.trim()}`,
    );
  }
  const refused = await answer("/");
  if (refused.status !== 403) {
    problems.push(`A path without the key got ${refused.status}, not 403.`);
  }
  return problems;
}
