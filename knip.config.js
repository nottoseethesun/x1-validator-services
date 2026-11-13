/**
 * @file knip.config.js
 * @description
 * knip's settings for the gate's unused-file check (`npm run
 * knip:files`). Its entry points are the features' programs and tests,
 * from scripts/lint-targets.js, the test helpers that tests start as
 * programs, and the project's own scripts and lint rules. Every other
 * JavaScript file must be imported by one of them.
 */

import {
  ENTRY_POINT_GLOBS,
  TEST_FILE_GLOBS,
  TEST_FOLDERS,
} from "./scripts/lint-targets.js";

export default {
  entry: [
    ...ENTRY_POINT_GLOBS,
    ...TEST_FILE_GLOBS,
    ...TEST_FOLDERS.map((folder) => `${folder}/helpers/**/*.js`),
    "scripts/*.js",
    "eslint-rules/*.js",
    "eslint-security.config.js",
  ],
  project: ["**/*.js"],
  ignore: ["project-kickoff-documents/**"],
};
