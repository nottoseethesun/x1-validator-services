/**
 * @file scripts/_coverage.js
 * @description
 * Judges the test run's coverage report, which Node.js's test runner
 * writes in the lcov format. Parsing and judging are pure functions, so
 * the gate's verdict can be tested on report text alone.
 *
 * Three rules make the verdict. The lines of all measured files together
 * must be at least the minimum share covered. Each high-risk file must
 * reach the high-risk share on its own, for lines and for branches. And
 * every module the gate expects must appear in the report at all, since
 * Node.js reports only the files a test loaded: a module no test loads
 * would otherwise escape the measure.
 */

/**
 * @typedef {object} FileCoverage
 * @property {string} file  The file's path, as the report gives it.
 * @property {number} linesFound  Lines that can run.
 * @property {number} linesHit  Lines that ran.
 * @property {number} branchesFound  Branches that can be taken.
 * @property {number} branchesHit  Branches that were taken.
 */

/**
 * Reads an lcov report into one record per file.
 * @param {string} text  The report.
 * @returns {FileCoverage[]} The files' figures, in report order.
 */
export function parseLcov(text) {
  const records = [];
  let current = null;
  for (const line of text.split("\n")) {
    const [tag, value] = splitLcovLine(line.trim());
    if (tag === "SF") {
      current = {
        file: value,
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
    } else if (tag === "end_of_record" && current !== null) {
      records.push(current);
      current = null;
    } else if (current !== null) {
      addLcovFigure(current, tag, value);
    }
  }
  return records;
}

/**
 * Splits one lcov line into its tag and its value.
 * @param {string} line  The line.
 * @returns {[string, string]} The tag, and the text after the first colon.
 */
function splitLcovLine(line) {
  const colon = line.indexOf(":");
  return colon === -1
    ? [line, ""]
    : [line.slice(0, colon), line.slice(colon + 1)];
}

/**
 * Copies one lcov summary figure into a file's record.
 * @param {FileCoverage} record  The record, changed in place.
 * @param {string} tag  The lcov tag.
 * @param {string} value  The figure, as text.
 */
function addLcovFigure(record, tag, value) {
  const figure = Number.parseInt(value, 10);
  switch (tag) {
    case "LF":
      record.linesFound = figure;
      break;
    case "LH":
      record.linesHit = figure;
      break;
    case "BRF":
      record.branchesFound = figure;
      break;
    case "BRH":
      record.branchesHit = figure;
      break;
    default:
      break;
  }
}

/**
 * Works out a share as a percentage. Nothing to cover counts as fully
 * covered.
 * @param {number} hit  Covered.
 * @param {number} found  Coverable.
 * @returns {number} The percentage.
 */
function percent(hit, found) {
  return found === 0 ? 100 : (hit / found) * 100;
}

/**
 * Judges a coverage report against the gate's rules.
 * @param {FileCoverage[]} records  The report's files.
 * @param {object} rules  The rules.
 * @param {number} rules.minLinePercent  The minimum share of all
 *   measured lines covered.
 * @param {string[]} rules.highRiskFiles  Files held to the high-risk
 *   share, as path endings the report's paths are matched against.
 * @param {number} rules.highRiskPercent  The share each high-risk file
 *   needs, for lines and for branches.
 * @param {string[]} rules.expectedFiles  Files the report must include,
 *   as path endings.
 * @returns {{ok: boolean, linePercent: number, problems: string[]}} The
 *   verdict, the overall line share, and one message per broken rule.
 */
export function coverageVerdict(records, rules) {
  const problems = [];
  const linesFound = records.reduce((sum, r) => sum + r.linesFound, 0);
  const linesHit = records.reduce((sum, r) => sum + r.linesHit, 0);
  const linePercent = percent(linesHit, linesFound);
  if (linePercent < rules.minLinePercent) {
    problems.push(
      `Line coverage is ${linePercent.toFixed(2)}%, below the ` +
        `${rules.minLinePercent}% minimum.`,
    );
  }
  for (const file of rules.highRiskFiles) {
    problems.push(...highRiskProblems(records, file, rules.highRiskPercent));
  }
  for (const file of rules.expectedFiles) {
    const record = findRecord(records, file);
    if (record === undefined || record === null) {
      problems.push(`No test loads ${file}, so its coverage is unmeasured.`);
    }
  }
  return { ok: problems.length === 0, linePercent, problems };
}

/**
 * Finds a file's record by the ending of its path.
 * @param {FileCoverage[]} records  The report's files.
 * @param {string} file  The path ending, with forward slashes.
 * @returns {FileCoverage|undefined} The record, if the report has it.
 */
function findRecord(records, file) {
  return records.find((record) =>
    record.file.replaceAll("\\", "/").endsWith(file),
  );
}

/**
 * Checks one high-risk file against its share.
 * @param {FileCoverage[]} records  The report's files.
 * @param {string} file  The file's path ending.
 * @param {number} needed  The share it needs, for lines and branches.
 * @returns {string[]} One message per shortfall; none when it passes.
 */
function highRiskProblems(records, file, needed) {
  const record = findRecord(records, file);
  if (record === undefined || record === null) {
    return [`High-risk file ${file} is missing from the coverage report.`];
  }
  const lines = percent(record.linesHit, record.linesFound);
  const branches = percent(record.branchesHit, record.branchesFound);
  const problems = [];
  if (lines < needed) {
    problems.push(
      `${file}: line coverage ${lines.toFixed(2)}%, needs ${needed}%.`,
    );
  }
  if (branches < needed) {
    problems.push(
      `${file}: branch coverage ${branches.toFixed(2)}%, needs ${needed}%.`,
    );
  }
  return problems;
}
