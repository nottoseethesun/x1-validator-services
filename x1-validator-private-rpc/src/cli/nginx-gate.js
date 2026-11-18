/**
 * @file x1-validator-private-rpc/src/cli/nginx-gate.js
 * @description
 * Checks the request path from the server itself.
 *
 * The checks reach nginx on the public address, with the tls server
 * name and the Host header set to the hostname, so they work whatever
 * the dns record says. With Let's Encrypt's staging service they trust
 * the staging roots the tool ships. Otherwise they trust Node.js's usual
 * roots.
 */

import fs from "node:fs";
import { makeApiKey } from "../lib/api-key.js";
import { GATE_PAGE_NAME, GATE_PAGE_PATH } from "../lib/gate-page.js";
import { pollUntil } from "../lib/poll.js";

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
 * @property {string} [ca]  The roots to trust, or Node.js's own when
 *   absent.
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
    ...(setup.staging === true ? { ca: stagingRoots() } : {}),
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
 * Asks for the gate page, which says ok when nginx answers with its
 * certificate, and keeps the certificate nginx served with it.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @returns {Promise<{gate: string, certificate: object|null,
 *   failure: string}>} `ok`, or what came instead. The certificate, or
 *   null with no answer. Why no answer came, or "" when one did.
 */
export async function askGate(host, target) {
  try {
    const answer = await askNginx(host, target, GATE_PAGE_PATH);
    return {
      gate:
        answer.status === 200 ? answer.body.trim() : `http ${answer.status}`,
      certificate: answer.certificate,
      failure: "",
    };
  } catch (error) {
    return {
      gate: `no answer (${error.message})`,
      certificate: null,
      failure: error.message,
    };
  }
}

/**
 * Reads the gate page.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @returns {Promise<string>} `ok`, or what came instead.
 */
export async function readGate(host, target) {
  return (await askGate(host, target)).gate;
}

/**
 * Waits until nginx answers the gate page with `ok`: its certificate is
 * in place and checks out.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @param {number} waitMs  How long to wait in all.
 * @param {number} pollMs  How long to wait between two looks.
 * @returns {Promise<string>} The gate page's last answer.
 */
export async function waitForGate(host, target, waitMs, pollMs) {
  const { answer } = await pollUntil(
    () => readGate(host, target),
    (gate) => gate === "ok",
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
 * Checks the whole request path from the server: the gate page says ok,
 * the keyed path reaches the rpc's health check when there's a key to
 * try, and a path without a key, or with a random one, gets a 403.
 * @param {object} host  The host.
 * @param {Target} target  Where to ask.
 * @param {string} key  An api key nginx holds, or "" when the caller has
 *   none in hand, since the tool keeps only the keys' hashes.
 * @returns {Promise<string[]>} What failed, or nothing when all passed.
 */
export async function requestPathProblems(host, target, key) {
  const problems = [];
  const gate = await readGate(host, target);
  if (gate !== "ok") {
    problems.push(`${GATE_PAGE_NAME} says ${gate}, not ok.`);
  }
  const answer = (urlPath) =>
    askNginx(host, target, urlPath).catch((error) => ({
      status: 0,
      body: error.message,
    }));
  if (key !== "") {
    const health = await answer(`/${key}/health`);
    if (health.status !== 200 || health.body.trim() !== "ok") {
      problems.push(
        `The keyed path's health check answered ${health.status}: ${health.body.trim()}`,
      );
    }
  }
  const refused = await answer("/");
  if (refused.status !== 403) {
    problems.push(`A path without a key got ${refused.status}, not 403.`);
  }
  const randomKey = makeApiKey();
  const stranger = await answer(`/${randomKey}/health`);
  if (stranger.status !== 403) {
    problems.push(`A path with a random key got ${stranger.status}, not 403.`);
  }
  return problems;
}
