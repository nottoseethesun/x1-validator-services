/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/terminal.js
 * @description
 * How the nginx upgrade check talks to the person at the terminal: its
 * progress lines, a spinner beside each long step, its answer to Ctrl-C,
 * and the outcome with its exit code. index.js hands in the process for
 * Ctrl-C, its stdout, and ora for the spinner; tests hand in stand-ins.
 */

const PREFIX = "[validate-nginx-upgrade]";

/**
 * Builds how the check talks to the person at the terminal.
 *
 * While the spinner turns, ora reads the keyboard itself, so a Ctrl-C
 * reaches only this program, and apt's work underneath finishes. At other
 * times a Ctrl-C also stops the command running, and that step fails.
 * Either way the check stops at its next step and removes what it added.
 * @param {object} io  What the terminal is made of.
 * @param {{isTTY?: boolean, columns?: number}} io.stdout  The output
 *   stream, where the spinner draws.
 * @param {{on: Function}} io.signals  What emits `SIGINT` on Ctrl-C: the
 *   process.
 * @param {(options: object) => object} io.makeSpinner  Makes a spinner,
 *   as ora does.
 * @returns {{report: Function, wait: Function, isInterrupted: Function}}
 */
export function createTerminal({ stdout, signals, makeSpinner }) {
  let spinner = null;
  let interrupted = false;
  const report = (line) => {
    spinner?.clear();
    console.log(`${PREFIX} ${line}`);
    spinner?.render();
  };
  signals.on("SIGINT", () => {
    if (!interrupted) {
      interrupted = true;
      report(
        "Ctrl-C: stopping after this step, then removing everything the " +
          "check added.",
      );
    }
  });
  // ora needs a terminal that reports its width; it never stops otherwise.
  const canSpin = stdout.isTTY === true && stdout.columns > 0;
  const wait = async (line, work) => {
    if (!canSpin) {
      report(line);
      return work();
    }
    spinner = makeSpinner({ text: `${PREFIX} ${line}`, stream: stdout });
    spinner.start();
    try {
      return await work();
    } finally {
      spinner.stopAndPersist({ symbol: "" });
      spinner = null;
    }
  };
  return { report, wait, isInterrupted: () => interrupted };
}

/**
 * Prints the check's outcome: a pass on stdout, or each problem and each
 * step it couldn't undo on stderr, one line at a time.
 * @param {{passed: boolean, problems: string[], leftovers: string[]}}
 *   result  The check's verdict.
 * @param {(line: string) => void} report  Prints a progress line.
 * @returns {number} The exit code: 0 when it passed, 1 otherwise.
 */
export function reportOutcome(result, report) {
  if (result.passed) {
    report("Passed: an apt upgrade of nginx keeps the gated rpc unlocked.");
    return 0;
  }
  const lines = [...result.problems, ...result.leftovers].flatMap((problem) =>
    problem.split("\n"),
  );
  lines.push(
    result.leftovers.length === 0
      ? "Failed. The check removed everything it added."
      : "Failed, and some of what the check added is still in place, as " +
          'listed above. Run each "By hand" command, in the order listed, ' +
          "then run the check again.",
  );
  for (const line of lines) {
    console.error(`${PREFIX} ${line}`);
  }
  return 1;
}
