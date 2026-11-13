/*-
 * x1-validator-private-rpc.js: the api-key check that nginx's njs module runs.
 *
 * nginx calls forwardPath for every request. It returns the path to send to
 * the rpc, with the key removed, or '' to refuse the request with a 403. The
 * key comes from nginx's environment: the env directive keeps X1_RPC_KEY for
 * the worker processes, so the key never sits in a file. A missing or
 * malformed key refuses every request. gatePage answers the local-only status
 * page with "unlocked" or "locked", and never with the key itself.
 *
 * pathFor and gateFor are pure, so Node's test runner can test them directly.
 */

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Compares two strings in time that does not depend on where they differ. */
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

/** Returns the path to forward for this uri and key, or '' to refuse. */
function pathFor(uri, key) {
  if (!KEY_PATTERN.test(key)) {
    return '';
  }
  if (!sameText(uri.substring(1, 1 + key.length), key)) {
    return '';
  }
  const rest = uri.substring(1 + key.length);
  if (rest === '') {
    return '/';
  }
  return rest.startsWith('/') ? rest : '';
}

/** Returns "unlocked" when the key is usable, otherwise "locked". */
function gateFor(key) {
  return KEY_PATTERN.test(key) ? 'unlocked' : 'locked';
}

/** Reads the key that the start wrapper put in nginx's environment. */
function envKey() {
  return process.env.X1_RPC_KEY ?? '';
}

/** js_set handler: the path to forward, or '' to refuse. */
function forwardPath(r) {
  return pathFor(r.uri, envKey());
}

/** js_content handler for the local-only gate page. */
function gatePage(r) {
  r.headersOut['Content-Type'] = 'text/plain';
  r.return(200, gateFor(envKey()) + '\n');
}

export default { forwardPath, gatePage, pathFor, gateFor };
