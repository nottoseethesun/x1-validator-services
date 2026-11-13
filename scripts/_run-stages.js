/**
 * @file scripts/_run-stages.js
 * @description
 * Runs a list of gate stages one after another and reports on all of
 * them. Every stage runs even after one fails, so a single run shows
 * every problem; stopping at the first would take a run per problem. The
 * summary at the end lists each stage with its result.
 */

import { runInherited } from "./_tools.js";

/**
 * @typedef {object} StageResult
 * @property {string} name  The stage's name.
 * @property {boolean} passed  Whether it exited 0.
 */

/**
 * Runs each stage with the terminal attached, printing a heading first.
 * @param {import("./_gate-stages.js").Stage[]} stages  The stages.
 * @returns {StageResult[]} One result per stage, in order.
 */
export function runStages(stages) {
  return stages.map((stage) => {
    console.log(`\n── ${stage.name} ──`);
    const status = runInherited(stage.command, stage.args);
    return { name: stage.name, passed: status === 0 };
  });
}

/**
 * Prints one line per stage result, and the overall verdict.
 * @param {StageResult[]} results  The results.
 * @returns {boolean} Whether every stage passed.
 */
export function printSummary(results) {
  console.log("\n── Summary ──");
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name}`);
  }
  const allPassed = results.every((result) => result.passed);
  console.log(allPassed ? "\nAll checks passed." : "\nSome checks failed.");
  return allPassed;
}
