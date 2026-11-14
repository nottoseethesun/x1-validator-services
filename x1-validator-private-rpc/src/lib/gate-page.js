/**
 * @file x1-validator-private-rpc/src/lib/gate-page.js
 * @description
 * The gate page: a path where nginx answers `unlocked` when it holds a
 * usable api key, and `locked` when it doesn't, to requests from the
 * machine itself. Every nginx configuration the tool writes serves it,
 * and every check that asks whether nginx holds the key reads it.
 */

/** The gate page's path. */
export const GATE_PAGE_PATH = "/x1-rpc-gate";
