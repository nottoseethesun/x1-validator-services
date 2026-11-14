/**
 * @file x1-validator-private-rpc/src/lib/api-key.js
 * @description
 * The api key's format, written down once: 32 random bytes, written as
 * 64 lower-case hex characters. apply makes the key the clients use, and
 * util/validate-nginx-upgrade makes a throwaway one for its test nginx.
 * Two texts the tool writes depend on it: nginx's log mask, which puts
 * `<key>` in place of anything that looks like a key, and the start
 * wrapper, which passes nginx only a well-formed key.
 *
 * The key check that nginx runs, src/njs/x1-validator-private-rpc.js,
 * keeps a copy of the pattern, since nginx loads that file on its own;
 * its test holds the copy to this one.
 */

import crypto from "node:crypto";

/** How many hex characters a key has. */
export const API_KEY_HEX_DIGITS = 64;

/** A pattern that matches one key, for regular expressions. */
export const API_KEY_PATTERN = `[0-9a-f]{${API_KEY_HEX_DIGITS}}`;

/**
 * Makes a new key.
 * @returns {string} Random hex characters, API_KEY_HEX_DIGITS of them.
 */
export function makeApiKey() {
  return crypto.randomBytes(API_KEY_HEX_DIGITS / 2).toString("hex");
}
