/**
 * @file x1-validator-private-rpc/util/check-my-private-rpc/check.js
 * @description
 * check-my-private-rpc's work. It checks the two answers the operator
 * typed, sends the rpc its queries through the keyed url, one right
 * after another, and judges the answers. It reads the settings the check
 * uses, so tests can change them. Every request goes through the host,
 * so tests pass a stand-in. Nothing here prints.
 */

import { API_KEY_HEX_DIGITS, isApiKey } from "../../src/lib/api-key.js";
import { maskSecret } from "../../src/lib/mask-secret.js";
import { isHostname } from "../../src/lib/settings.js";

/** The json-rpc method each query calls: cheap, with an answer that moves. */
export const QUERY_METHOD = "getSlot";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** The statuses nginx answers with when it can't reach the rpc. */
const UPSTREAM_STATUSES = new Set([502, 503, 504]);

/**
 * @typedef {object} QueryResult
 * @property {number} query  Which query, counted from 1.
 * @property {number} ms  How long it took.
 * @property {number} status  The http status, or -1 when no http answer
 *   came.
 * @property {number} slot  The slot the rpc answered, or -1 when it
 *   didn't.
 * @property {string} kind  What came back: `ok`, `refused`,
 *   `rate-limited`, `upstream`, `http`, `rpc-error`, `not-rpc`, `dns`,
 *   `connect`, `tls` or `other`.
 * @property {string} detail  The rpc's error, or the request's error code
 *   or message, or "" when there is none.
 */

/**
 * Finds what's wrong with the two answers the operator typed. The
 * hostname follows the `hostname` setting's rule.
 * @param {string} hostname  The rpc's hostname.
 * @param {string} key  The api key.
 * @returns {string} The problem, or "" when there is none.
 */
export function inputProblem(hostname, key) {
  // What was typed isn't quoted: a pasted url would show the key.
  if (isHostname(hostname) === false) {
    return (
      "That isn't a hostname such as x1-rpc.example.com. " +
      "Leave out https://, any path and any port."
    );
  }
  if (isApiKey(key) === false) {
    return (
      "That isn't an api key, which has " +
      `${API_KEY_HEX_DIGITS} characters, each 0-9 or a-f.`
    );
  }
  return "";
}

/**
 * Reads the http answer to one query.
 * @param {{status: number, body: string}} answer  The answer.
 * @returns {Omit<QueryResult, "query"|"ms">}
 */
function readAnswer({ status, body }) {
  const failed = (kind, detail) => ({ status, slot: -1, kind, detail });
  if (status === 403) {
    return failed("refused", "");
  }
  if (status === 429) {
    return failed("rate-limited", "");
  }
  if (UPSTREAM_STATUSES.has(status)) {
    return failed("upstream", "");
  }
  if (status !== 200) {
    return failed("http", "");
  }
  let reply;
  try {
    reply = JSON.parse(body);
  } catch {
    return failed("not-rpc", "");
  }
  if (Number.isInteger(reply?.result)) {
    return { status, slot: reply.result, kind: "ok", detail: "" };
  }
  const message = reply?.error?.message;
  return typeof message === "string"
    ? failed("rpc-error", message)
    : failed("not-rpc", "");
}

/**
 * Sorts a request that got no http answer by what went wrong.
 * @param {Error & {code?: string}} error  The request's error.
 * @returns {Omit<QueryResult, "query"|"ms">}
 */
function readFailure(error) {
  const code = typeof error.code === "string" ? error.code : "";
  const kinds = [
    ["dns", DNS_CODES],
    ["connect", CONNECT_CODES],
    ["tls", TLS_CODES],
  ];
  const found = kinds.find(([, codes]) => codes.has(code));
  return {
    status: -1,
    slot: -1,
    kind: found === undefined || found === null ? "other" : found[0],
    detail: code === "" ? error.message : code,
  };
}

/**
 * Says what the check is about to do, with the key masked.
 * @param {object} settings  The settings, which say how many queries.
 * @param {string} hostname  The rpc's hostname.
 * @param {string} key  The api key.
 * @returns {string}
 */
export function checkingLine(settings, hostname, key) {
  return (
    `Checking https://${hostname}/${maskSecret(key)} with ` +
    `${settings.checkQueryCount} ${QUERY_METHOD} queries, one right after ` +
    "another."
  );
}

/**
 * Sends the queries through the keyed url, one right after another, as
 * many as the settings say, each with the settings' time to answer.
 * @param {object} host  The host.
 * @param {object} settings  The settings.
 * @param {object} target  What to query.
 * @param {string} target.hostname  The rpc's hostname.
 * @param {string} target.key  The api key.
 * @returns {Promise<QueryResult[]>}
 */
export async function sendQueries(host, settings, { hostname, key }) {
  const url = `https://${hostname}/${key}`;
  const count = settings.checkQueryCount;
  const timeoutMs = settings.requestTimeoutSeconds * 1000;
  const results = [];
  for (let query = 1; query <= count; query++) {
    const started = host.now();
    const body = { jsonrpc: "2.0", id: query, method: QUERY_METHOD };
    const read = await host
      .postJson(url, body, timeoutMs)
      .then(readAnswer, readFailure);
    results.push({ query, ms: host.now() - started, ...read });
  }
  return results;
}

/**
 * Explains one failed query, with what to do about it.
 * @param {QueryResult} result  The query.
 * @param {string} hostname  The rpc's hostname.
 * @returns {string}
 */
function explain(result, hostname) {
  const reasons = new Map([
    [
      "refused",
      "nginx refused the key, with http 403. Either the key is wrong, or " +
        "nginx is locked after a restart. On the validator, the url command " +
        "prints the right key, and unlock hands nginx the key again.",
    ],
    [
      "rate-limited",
      "nginx turned queries away with http 429, for going over its rate " +
        "limit. The rateLimitRequestsPerSecond setting sets that limit.",
    ],
    [
      "upstream",
      `nginx answered http ${result.status}, since it couldn't reach the ` +
        "validator's rpc. Check that the validator is running.",
    ],
    ["http", `The keyed url answered http ${result.status}.`],
    ["rpc-error", `The rpc answered with an error: ${result.detail}`],
    [
      "not-rpc",
      "The answer wasn't json-rpc, so the validator's rpc didn't send it.",
    ],
    [
      "dns",
      `${hostname} doesn't resolve to an address. Check its A record, as ` +
        "x1-validator-private-rpc/docs/manual-domain-setup.md shows.",
    ],
    [
      "connect",
      `Nothing answered on port 443 at ${hostname} (${result.detail}). ` +
        "Check that nginx is running, and that ufw lets tcp port 443 in.",
    ],
    [
      "tls",
      `${hostname}'s certificate isn't trusted (${result.detail}). A ` +
        "certificate from Let's Encrypt's staging service never is, so run " +
        "apply without --acme-staging.",
    ],
    ["other", result.detail],
  ]);
  return reasons.get(result.kind);
}

/**
 * Says whether every query worked, and what went wrong when one didn't.
 * The first failed query explains the failures.
 * @param {QueryResult[]} results  The queries.
 * @param {string} hostname  The rpc's hostname, for the advice.
 * @returns {{passed: boolean, verdict: string}}
 */
export function judge(results, hostname) {
  const failed = results.filter((result) => result.kind !== "ok");
  if (failed.length === 0) {
    return {
      passed: true,
      verdict: `Your private rpc answered all ${results.length} queries with the key.`,
    };
  }
  return {
    passed: false,
    verdict:
      `${failed.length} of ${results.length} queries failed. ` +
      explain(failed[0], hostname),
  };
}
