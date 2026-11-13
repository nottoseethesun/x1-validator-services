/**
 * @file scripts/_test-files.js
 * @description
 * Finds the test files the gate and `npm test` run: every file whose
 * name ends in `.test.js` in a test folder that scripts/lint-targets.js
 * names.
 *
 * Tests of the shipped settings end in `.config-values.test.js`. The gate
 * runs them before the rest, so a bad shipped value is reported as the
 * cause rather than as the many failures it would cause.
 */

import path from "node:path";
import { listFilesUnder } from "./_tools.js";
import { FEATURES, TEST_FOLDERS } from "./lint-targets.js";

const TEST_SUFFIX = ".test.js";
const CONFIG_VALUES_SUFFIX = ".config-values.test.js";

/**
 * Lists the test files in the given folders, sorted.
 * @param {string} root  The project's root.
 * @param {string[]} [folders]  The test folders, relative to the root;
 *   every test folder when left out.
 * @returns {string[]} The test files' paths, relative to the root.
 */
export function listTestFiles(root, folders = TEST_FOLDERS) {
  return folders
    .flatMap((folder) => listFilesUnder(root, folder))
    .filter((file) => file.endsWith(TEST_SUFFIX))
    .sort();
}

/**
 * Lists the test files of the features alone, leaving out the tests of
 * the project's own tooling.
 * @param {string} root  The project's root.
 * @returns {string[]} The test files' paths, relative to the root.
 */
export function listFeatureTestFiles(root) {
  return listTestFiles(
    root,
    FEATURES.map((feature) => path.join(feature, "test")),
  );
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
