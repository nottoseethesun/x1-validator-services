/**
 * @file x1-validator-private-rpc/src/lib/api-key.js
 * @description
 * The api key's format, written down once: 32 random bytes, written as
 * 64 lower-case hex characters. apply and add-api-key make the keys the
 * clients use, and util/validate-nginx-upgrade makes a throwaway one for
 * its test nginx. remove-api-key and util/check-my-private-rpc check
 * that a key typed in has the form. nginx's log mask, which puts `<key>`
 * in place of anything that looks like a key, depends on it, and so does
 * the same mask on a refused setting's value.
 *
 * The key check that nginx runs, src/njs/x1-validator-private-rpc.js,
 * keeps a copy of the pattern, since nginx loads that file on its own.
 * Its test holds the copy to this one.
 */

import crypto from "node:crypto";

/** How many hex characters a key has. */
export const API_KEY_HEX_DIGITS = 64;

/** A pattern that matches one key, for regular expressions. */
export const API_KEY_PATTERN = `[0-9a-f]{${API_KEY_HEX_DIGITS}}`;

/** A text that is one key and nothing else. */
const KEY_ALONE = new RegExp(`^${API_KEY_PATTERN}$`);

/**
 * Makes a new key.
 * @returns {string} Random hex characters, API_KEY_HEX_DIGITS of them.
 */
export function makeApiKey() {
  return crypto.randomBytes(API_KEY_HEX_DIGITS / 2).toString("hex");
}

/**
 * Tells whether a text has a key's form: the right length, and only
 * lower-case hex characters.
 * @param {string} text  The text.
 * @returns {boolean}
 */
export function isApiKey(text) {
  return KEY_ALONE.test(text);
}

/**
 * A run of hex digits half a key long or more, in either case, as
 * nginx's access log masks: a key typed a character short or long is one
 * too.
 */
const KEY_LIKE_RUN = new RegExp(`[0-9A-Fa-f]{${API_KEY_HEX_DIGITS / 2},}`, "g");

/**
 * Puts `<key>` in place of anything in a text that looks like a key, as
 * nginx's access log does.
 * @param {string} text  The text.
 * @returns {string} The text, masked.
 */
export function maskKeyLikeRuns(text) {
  return text.replace(KEY_LIKE_RUN, "<key>");
}
