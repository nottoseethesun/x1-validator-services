/**
 * @file scripts/_test-files.js
 * @description
 * Finds the test files the gate and `npm test` run: every file whose
 * name ends in `.test.js` in a test folder that scripts/lint-targets.js
 * names. It also holds the time limit the two give each test.
 *
 * Tests of the shipped settings end in `.config-values.test.js`. The gate
 * runs them before the rest, so a bad shipped value is reported as the
 * cause rather than as the many failures it would cause.
 */

import { listFilesUnder } from "./_tools.js";
import { TEST_FOLDERS } from "./lint-targets.js";

const TEST_SUFFIX = ".test.js";
const CONFIG_VALUES_SUFFIX = ".config-values.test.js";

/**
 * The test runner's option that gives each test a minute, which the gate
 * and `npm test` pass. A test, or a hook such as `beforeEach`, still
 * running then fails, by name, and the rest of its file runs. Without a
 * limit, a test that never finishes would hold the whole run open, since
 * from Node.js 24 on the runner keeps a test file's process running
 * until each of its tests has finished. The limit is for each test, not
 * for a `describe` group or a file. The slowest test takes under four
 * seconds on CI. A test file that leaves a timer running never exits
 * after its last test, and no test's limit can end that: in CI, the
 * check job's 20-minute cap does.
 */
export const TEST_TIMEOUT = "--test-timeout=60000";

/**
 * Lists the test files in the given folders, sorted.
 * @param {string} root  The project's root.
 * @param {string[]} [folders]  The test folders, relative to the root,
 *   or every test folder when left out.
 * @returns {string[]} The test files' paths, relative to the root.
 */
export function listTestFiles(root, folders = TEST_FOLDERS) {
  return folders
    .flatMap((folder) => listFilesUnder(root, folder))
    .filter((file) => file.endsWith(TEST_SUFFIX))
    .sort();
}

/**
 * Splits test files into the shipped-settings tests and the rest.
 * @param {string[]} files  Test files.
 * @returns {{configValues: string[], others: string[]}} The two groups,
 *   each in its original order.
 */
export function splitConfigValueTests(files) {
  return {
    configValues: files.filter((file) => file.endsWith(CONFIG_VALUES_SUFFIX)),
    others: files.filter((file) => !file.endsWith(CONFIG_VALUES_SUFFIX)),
  };
}
