/**
 * @file x1-validator-private-rpc/src/lib/poll.js
 * @description
 * Waits for another program to reach a state, by asking it again at an
 * interval until it answers as wanted or the time runs out. This is for
 * waiting on systems the tool doesn't control, such as nginx starting
 * under systemd; it never stands in for ordering the tool's own work.
 * The clock and the pause come from the caller, so tests run without
 * waiting.
 */

/**
 * Asks until the answer is the one wanted, or the time is up.
 * @template T
 * @param {() => Promise<T>} read  Asks once.
 * @param {(answer: T) => boolean} isWanted  Decides whether an answer is
 *   the one wanted.
 * @param {object} timing  When to stop, and how to wait.
 * @param {number} timing.timeoutMs  How long to keep asking.
 * @param {number} timing.intervalMs  The pause between two questions.
 * @param {() => number} timing.now  The current time, in milliseconds.
 * @param {(ms: number) => Promise<void>} timing.sleep  Pauses.
 * @returns {Promise<{wanted: boolean, answer: T}>} Whether the wanted
 *   answer came, and the last answer.
 */
export async function pollUntil(read, isWanted, timing) {
  const deadline = timing.now() + timing.timeoutMs;
  let answer = await read();
  while (!isWanted(answer) && timing.now() < deadline) {
    await timing.sleep(timing.intervalMs);
    answer = await read();
  }
  return { wanted: isWanted(answer), answer };
}
