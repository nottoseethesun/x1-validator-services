/**
 * @file x1-validator-private-rpc/src/lib/gate-page.js
 * @description
 * The gate page: a path where nginx answers `ok`, to requests from the
 * machine itself, once it serves its certificate. Every nginx
 * configuration the tool writes serves it, and every check that asks
 * whether nginx answers reads it.
 */

/** The gate page's path. */
export const GATE_PAGE_PATH = "/x1-rpc-gate";
