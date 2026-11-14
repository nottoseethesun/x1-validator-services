/**
 * @file x1-validator-private-rpc/src/njs/x1-validator-private-rpc.js
 * @description
 * The api-key check that nginx's njs module runs.
 *
 * nginx calls forwardPath for every request. It returns the path to send to
 * the rpc, with the key removed, or '' to refuse the request with a 403. The
 * key comes from nginx's environment: the env directive keeps X1_RPC_KEY for
 * the worker processes, so the key never sits in a file. A missing or
 * malformed key refuses every request. gatePage answers the local-only status
 * page with "unlocked" or "locked", and never with the key itself.
 *
 * The tool installs this file into nginx as it is; no Node.js entry point
 * loads it. So it keeps its own copy of the key's pattern, which its test
 * holds to the one in src/lib/api-key.js. pathFor and gateFor are pure, so
 * Node's test runner can test them directly.
 */

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Compares two strings in time that doesn't depend on where they differ,
 * so a request's timing never tells how much of the key it got right.
 * @param {string} a  One string.
 * @param {string} b  The other.
 * @returns {boolean} Whether they're the same.
 */
function sameText(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Finds the path to forward for a request.
 * @param {string} uri  The request's normalized path.
 * @param {string} key  The api key from nginx's environment.
 * @returns {string} What follows the key in the path, `/` when nothing
 *   does, or '' to refuse the request.
 */
function pathFor(uri, key) {
  if (!KEY_PATTERN.test(key)) {
    return "";
  }
  if (!sameText(uri.substring(1, 1 + key.length), key)) {
    return "";
  }
  const rest = uri.substring(1 + key.length);
  if (rest === "") {
    return "/";
  }
  return rest.startsWith("/") ? rest : "";
}

/**
 * Says whether nginx holds a usable key.
 * @param {string} key  The api key from nginx's environment.
 * @returns {string} "unlocked" when the key is well formed, otherwise
 *   "locked".
 */
function gateFor(key) {
  return KEY_PATTERN.test(key) ? "unlocked" : "locked";
}

/**
 * Reads the key that the start wrapper put in nginx's environment.
 * @returns {string} The key, or '' when there is none.
 */
function envKey() {
  return process.env.X1_RPC_KEY ?? "";
}

/**
 * The js_set handler: the path to forward for a request.
 * @param {object} r  nginx's request.
 * @returns {string} The path, or '' to refuse the request.
 */
function forwardPath(r) {
  const key = envKey();
  return pathFor(r.uri, key);
}

/**
 * The js_content handler for the local-only gate page: it answers
 * "unlocked" or "locked", as plain text.
 * @param {object} r  nginx's request.
 */
function gatePage(r) {
  const key = envKey();
  r.headersOut["Content-Type"] = "text/plain";
  r.return(200, gateFor(key) + "\n");
}

export default { forwardPath, gatePage, pathFor, gateFor };
