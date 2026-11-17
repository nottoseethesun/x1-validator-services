/**
 * @file x1-validator-private-rpc/src/lib/key-hash-map.js
 * @description
 * nginx's list of the api keys' hashes, written down once. A key's hash
 * is its SHA-256, in hex, as nginx's key check computes it. The list has
 * one `<hash> 1;` line per key, for nginx's map to include, with the
 * map's hash table sized to hold it. The tool's list comes from
 * src/cli/hashed-api-keys.js, and util/validate-nginx-upgrade writes a
 * throwaway one for its test nginx.
 */

import crypto from "node:crypto";

/**
 * The size of the map's hash table. nginx's usual bucket is a cache
 * line, 64 bytes on x86, which can't hold a 64-character hash. A bucket
 * of 128 holds just one, so nginx can't build the table it wants. It
 * then searches every size up to the maximum: 10,000 keys took 20
 * seconds to start. Measured with nginx 1.30.6, buckets of 1024 bytes
 * and a maximum of 524288 build the table at once for 1 to 500,000 keys:
 * 500,000 started in 0.66 seconds and reloaded in 1.4.
 */
export const MAP_HASH_BUCKET_SIZE = 1024;
export const MAP_HASH_MAX_SIZE = 524288;

/** A key's hash: SHA-256, as 64 lower-case hex characters. */
const HASH_FORM = "[0-9a-f]{64}";
export const HASH_PATTERN = new RegExp(`^${HASH_FORM}$`);
const MAP_LINE_PATTERN = new RegExp(`^${HASH_FORM} 1;$`);

/**
 * Hashes an api key, as nginx's key check does.
 * @param {string} apiKey  The key.
 * @returns {string} Its SHA-256 hash, in hex.
 */
export function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Writes the list's text: one line per hash.
 * @param {string[]} hashes  The keys' hashes.
 * @returns {string}
 */
export function mapText(hashes) {
  return hashes.map((hash) => `${hash} 1;\n`).join("");
}

/**
 * Counts the keys in the list's text.
 * @param {string} text  The list's text.
 * @returns {number}
 */
export function countMapLines(text) {
  return text.split("\n").filter((line) => MAP_LINE_PATTERN.test(line)).length;
}
