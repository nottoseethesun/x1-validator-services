/**
 * @file x1-validator-private-rpc/src/njs/x1-validator-private-rpc.js
 * @description
 * The key check that nginx's njs module runs. nginx never holds an api
 * key: it holds a list of the keys' SHA-256 hashes, which its map includes.
 *
 * For every request nginx calls keyHash, which returns the SHA-256 hash of
 * the key at the start of the path, or '' when the path doesn't start with
 * one. nginx's map looks the hash up in its list, and a request whose hash
 * isn't there gets a 403. forwardPath returns the path to send to the rpc,
 * with the key removed. loggedUri gives the access log the request's url
 * with `<key>` in place of anything that looks like a key, wherever the
 * client put it. nginx's map could replace only one such run, and a url
 * can carry the key twice, in the path and the query string. gatePage
 * answers the local-only gate page with "ok", which tells the tool that
 * nginx answers, with its certificate.
 *
 * The tool installs this file into nginx as it is. No Node.js entry point
 * loads it. So it keeps its own copy of the key's pattern, which its test
 * holds to the one in src/lib/api-key.js. keyOf, pathFor, hashFor and
 * maskUri are pure, so Node's test runner can test them directly. crypto is njs's own
 * module, and Node.js has one of the same name, with the same createHash.
 */

import crypto from "crypto";

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const KEY_LENGTH = 64;

/**
 * A run of hex digits half a key long or more, in either case, which the
 * access log masks: a key typed a character short or long is one too.
 */
const MASKED_RUN = new RegExp(`[0-9A-Fa-f]{${KEY_LENGTH / 2},}`, "g");

/**
 * Finds the key at the start of a request's path.
 * @param {string} uri  The request's normalized path.
 * @returns {string} The key, or '' when the path doesn't start with a
 *   well-formed key followed by `/` or by nothing.
 */
function keyOf(uri) {
  const key = uri.substring(1, 1 + KEY_LENGTH);
  const rest = uri.substring(1 + KEY_LENGTH);
  if (!KEY_PATTERN.test(key) || (rest !== "" && !rest.startsWith("/"))) {
    return "";
  }
  return key;
}

/**
 * Finds the path to forward for a request.
 * @param {string} uri  The request's normalized path.
 * @returns {string} What follows the key in the path, `/` when nothing
 *   does, or '' when the path doesn't start with a key.
 */
function pathFor(uri) {
  if (keyOf(uri) === "") {
    return "";
  }
  const rest = uri.substring(1 + KEY_LENGTH);
  return rest === "" ? "/" : rest;
}

/**
 * Hashes the key at the start of a request's path, as the tool hashes
 * each key it makes.
 * @param {string} uri  The request's normalized path.
 * @returns {string} The key's SHA-256 hash, in hex, or '' when the path
 *   doesn't start with a key.
 */
function hashFor(uri) {
  const key = keyOf(uri);
  if (key === "") {
    return "";
  }
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Writes a request's url as the access log shows it.
 * @param {string} uri  The request's url, as the client sent it, with its
 *   query string.
 * @returns {string} The url, with `<key>` in place of each run of hex
 *   digits half a key long or more, in the path or the query string.
 */
function maskUri(uri) {
  return uri.replace(MASKED_RUN, "<key>");
}

/**
 * The js_set handler for the key's hash, which nginx's map looks up.
 * @param {object} r  nginx's request.
 * @returns {string} The hash, or ''.
 */
function keyHash(r) {
  return hashFor(r.uri);
}

/**
 * The js_set handler for the path to forward.
 * @param {object} r  nginx's request.
 * @returns {string} The path, or ''.
 */
function forwardPath(r) {
  return pathFor(r.uri);
}

/**
 * The js_set handler for the url the access log shows.
 * @param {object} r  nginx's request.
 * @returns {string} The masked url, or '' when the request has none.
 */
function loggedUri(r) {
  const uri = r.variables.request_uri;
  if (uri === undefined || uri === null) {
    return "";
  }
  return maskUri(uri);
}

/**
 * The js_content handler for the local-only gate page: it answers "ok",
 * as plain text.
 * @param {object} r  nginx's request.
 */
function gatePage(r) {
  r.headersOut["Content-Type"] = "text/plain";
  r.return(200, "ok\n");
}

export default {
  keyHash,
  forwardPath,
  loggedUri,
  gatePage,
  keyOf,
  pathFor,
  hashFor,
  maskUri,
};
