/**
 * @file scripts/lint-targets.js
 * @description
 * The one list of files each gate checks. ESLint, Prettier, the security
 * pass, the secret scan, Markdown lint, the dead-code checks, the test
 * runner and the coverage report all take their lists from here, so no
 * two of them can check different files.
 *
 * The project is a set of features, each in a sub-directory of its own
 * with `src/`, `test/` and, when it has standalone tools, `util/`. Every
 * list below is built from FEATURES, so a new feature joins every gate by
 * being named there. A feature's entry points are the files directly in
 * its `src/` and its `util/` tools; the modules they load sit in folders
 * under `src/`.
 */

/**
 * The project's feature sub-directories.
 * @type {string[]}
 */
export const FEATURES = ["x1-validator-private-rpc"];

/**
 * Where the programs a person or a scheduler starts by their path live:
 * the files directly in each feature's `src/`, and its standalone tools,
 * each either one file directly in `util/` or a folder in `util/` whose
 * `index.js` is the entry point. The dead-code checks walk the imports
 * from these files. A pattern is either `*.js`, a file directly in the
 * folder, or `* /index.js` without the space, an `index.js` one folder
 * down.
 * @type {{folder: string, pattern: string}[]}
 */
export const ENTRY_POINT_PLACES = FEATURES.flatMap((feature) => [
  { folder: `${feature}/src`, pattern: "*.js" },
  { folder: `${feature}/util`, pattern: "*.js" },
  { folder: `${feature}/util`, pattern: "*/index.js" },
]);

/**
 * The entry points, as globs.
 * @type {string[]}
 */
export const ENTRY_POINT_GLOBS = ENTRY_POINT_PLACES.map(
  ({ folder, pattern }) => `${folder}/${pattern}`,
);

/**
 * Folders of files a feature installs into another program instead of
 * importing: the njs modules nginx runs. No entry point loads them, but
 * tests do, and their own lint block knows they run in njs, not Node.js.
 * @type {string[]}
 */
export const INSTALLED_FOLDERS = FEATURES.map(
  (feature) => `${feature}/src/njs`,
);

/**
 * The installed files, as globs.
 * @type {string[]}
 */
export const INSTALLED_GLOBS = INSTALLED_FOLDERS.map(
  (folder) => `${folder}/**/*.js`,
);

/**
 * The folders that hold tests: the root's, for the project's own
 * tooling, and each feature's.
 * @type {string[]}
 */
export const TEST_FOLDERS = [
  "test",
  ...FEATURES.map((feature) => `${feature}/test`),
];

/**
 * Test files, as globs.
 * @type {string[]}
 */
export const TEST_FILE_GLOBS = TEST_FOLDERS.map(
  (folder) => `${folder}/**/*.test.js`,
);

/**
 * Every JavaScript file in a test folder, helpers included, as globs.
 * @type {string[]}
 */
export const TEST_JS_TARGETS = TEST_FOLDERS.map(
  (folder) => `${folder}/**/*.js`,
);

/**
 * JavaScript files that only ever run in the full gate, on Node.js 24:
 * the tests of the project's own tooling, the lint rules, and the tools'
 * configuration files. Everything else also runs on Node.js 20.0.0, on
 * the validator or in the gate's tests-only mode.
 * @type {string[]}
 */
export const FULL_GATE_ONLY_TARGETS = [
  "test/**/*.js",
  "eslint-rules/**/*.js",
  "*.config.js",
];

/**
 * Every JavaScript file under ESLint and Prettier, as globs.
 * @type {string[]}
 */
export const JS_TARGETS = [
  "*.js",
  "scripts/**/*.js",
  "eslint-rules/**/*.js",
  ...TEST_JS_TARGETS,
  ...FEATURES.flatMap((feature) => [
    `${feature}/src/**/*.js`,
    `${feature}/util/**/*.js`,
  ]),
];

/**
 * Code the security pass checks, as globs: what runs on the validator,
 * and the project's own scripts. Tests are left out.
 * @type {string[]}
 */
export const SECURITY_TARGETS = [
  "scripts/**/*.js",
  ...FEATURES.flatMap((feature) => [
    `${feature}/src/**/*.js`,
    `${feature}/util/**/*.js`,
  ]),
];

/**
 * Files the secret scan checks, as globs: the security pass's code, plus
 * the places a credential is most likely to be committed by accident.
 * @type {string[]}
 */
export const SECRET_TARGETS = [...SECURITY_TARGETS, ".env*", "**/*.json"];

/**
 * Markdown files under markdownlint, as globs.
 * @type {string[]}
 */
export const MARKDOWN_TARGETS = [
  "README.md",
  "CLAUDE.md",
  "docs/*.md",
  "docs/claude/*.md",
  ...FEATURES.flatMap((feature) => [
    `${feature}/README.md`,
    `${feature}/docs/*.md`,
  ]),
];

/**
 * Code the coverage report measures, as globs: what runs on the
 * validator.
 * @type {string[]}
 */
export const COVERAGE_TARGETS = FEATURES.flatMap((feature) => [
  `${feature}/src/**/*.js`,
  `${feature}/util/**/*.js`,
]);
