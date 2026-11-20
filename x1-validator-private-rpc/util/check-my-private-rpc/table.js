/**
 * @file x1-validator-private-rpc/util/check-my-private-rpc/table.js
 * @description
 * Draws check-my-private-rpc's report: a table with a row per query, a
 * line of totals, and the verdict. The verdict starts with a green check
 * mark when every query worked, or a red cross when one didn't. Colors
 * go only to a terminal. Every function is pure, so tests read the lines.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** What the Answer column says for each kind of failed query. */
const ANSWERS = new Map([
  ["refused", "key refused"],
  ["rate-limited", "over the rate limit"],
  ["upstream", "rpc out of reach"],
  ["http", "unexpected answer"],
  ["not-rpc", "not json-rpc"],
]);

/**
 * Draws rows as a table framed with box-drawing lines, each column as
 * wide as its widest cell.
 * @param {string[]} header  The columns' titles.
 * @param {string[][]} rows  The cells, row by row.
 * @param {boolean[]} rightAligned  Which columns align to the right.
 * @returns {string[]} The table's lines.
 */
function boxTable(header, rows, rightAligned) {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row.at(column).length)),
  );
  const cell = (text, column) =>
    rightAligned.at(column) === true
      ? text.padStart(widths.at(column))
      : text.padEnd(widths.at(column));
  const line = (cells) => `│ ${cells.map(cell).join(" │ ")} │`;
  const rule = (left, middle, right) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  return [
    rule("┌", "┬", "┐"),
    line(header),
    rule("├", "┼", "┤"),
    ...rows.map(line),
    rule("└", "┴", "┘"),
  ];
}

/**
 * Says what one query got back, in a few words.
 * @param {import("./check.js").QueryResult} result  The query.
 * @returns {string}
 */
function answerOf(result) {
  if (result.kind === "ok") {
    return `slot ${result.slot}`;
  }
  return ANSWERS.get(result.kind) ?? result.detail;
}

/**
 * Draws the verdict, with its mark.
 * @param {boolean} passed  Whether every query worked.
 * @param {string} verdict  What happened, in a sentence or two.
 * @param {boolean} color  Whether the output is a terminal.
 * @returns {string}
 */
export function renderVerdict(passed, verdict, color) {
  const mark = passed === true ? "✔" : "✘";
  if (color === false) {
    return `${mark} ${verdict}`;
  }
  return `${passed === true ? GREEN : RED}${mark}${RESET} ${verdict}`;
}

/**
 * Draws the whole report: the table, the totals and the verdict.
 * @param {import("./check.js").QueryResult[]} results  The queries.
 * @param {{passed: boolean, verdict: string}} judged  The verdict.
 * @param {boolean} color  Whether the output is a terminal.
 * @returns {string[]} The report's lines.
 */
export function renderReport(results, judged, color) {
  const rows = results.map((result) => [
    String(result.query),
    result.status === -1 ? "-" : String(result.status),
    answerOf(result),
    `${result.ms} ms`,
  ]);
  const table = boxTable(["#", "Status", "Answer", "Time"], rows, [
    true,
    true,
    false,
    true,
  ]);
  const answered = results.filter((result) => result.kind === "ok").length;
  const times = results.map((result) => result.ms);
  const average = Math.round(
    times.reduce((sum, ms) => sum + ms, 0) / times.length,
  );
  const totals =
    `Answered ${answered} of ${results.length}. Fastest ` +
    `${Math.min(...times)} ms, average ${average} ms, slowest ` +
    `${Math.max(...times)} ms.`;
  return [
    ...table,
    totals,
    "",
    renderVerdict(judged.passed, judged.verdict, color),
  ];
}
