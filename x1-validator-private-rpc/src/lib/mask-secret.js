/**
 * @file x1-validator-private-rpc/src/lib/mask-secret.js
 * @description
 * How a secret shows wherever it would otherwise appear in full: as its
 * last four characters, enough to tell two keys apart. The commands'
 * logger and check-my-private-rpc share it.
 */

/** How many of a secret's last characters its mask shows. */
export const MASK_TAIL_LENGTH = 4;

/**
 * Masks a secret down to its last four characters.
 * @param {string} secret  The secret.
 * @returns {string} Such as `…3f9a`.
 */
export function maskSecret(secret) {
  return `…${secret.slice(-MASK_TAIL_LENGTH)}`;
}
