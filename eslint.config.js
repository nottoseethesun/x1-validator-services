/**
 * @file eslint.config.js
 * @description
 * The main lint rules for every JavaScript file the gate checks, as an
 * ESLint flat configuration. The files come from scripts/lint-targets.js,
 * the lists every check shares.
 *
 * ESLint's recommended rules catch common bugs. On top of them sit the
 * project's limits, from LP Ranger's conventions: cyclomatic complexity
 * at most 17 per function, at most 500 lines of code per file, strict
 * equality, no `var`, no comment that switches Prettier off, no
 * `Math.random()`, no classes, no imports inside functions and no
 * re-exports. The one exception: a program in LATE_IMPORT_TARGETS loads
 * a package an older Node.js can't parse inside a function, once its
 * check of the Node.js has passed. eslint-plugin-n fails an import that
 * doesn't resolve, and
 * any Node.js api or syntax newer than the oldest version `engines` in
 * package.json allows, the oldest Node.js the project supports.
 *
 * The security rules run in a pass of their own, eslint-security.config
 * .js. Their plugins are registered here too, so a one-line exception
 * for a security rule is understood by both passes.
 * eslint-config-prettier comes last, leaving formatting to Prettier.
 */

import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import nPlugin from "eslint-plugin-n";
import noSecretsPlugin from "eslint-plugin-no-secrets";
import securityPlugin from "eslint-plugin-security";
import globals from "globals";
import noSecretLogging from "./eslint-rules/no-secret-logging.js";
import {
  CODE_FUZZING_TARGETS,
  INSTALLED_GLOBS,
  JS_TARGETS,
  LATE_IMPORT_TARGETS,
  TEST_JS_TARGETS,
} from "./scripts/lint-targets.js";

const MATH_RANDOM = {
  selector:
    'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
  message:
    "Use node:crypto, not Math.random(): it isn't cryptographically secure.",
};

const STRUCTURE_RULES = [
  {
    selector: "ImportExpression",
    message:
      "Import at the top of the module; never load a module inside a " +
      "function.",
  },
  {
    selector: "ExportNamedDeclaration[source], ExportAllDeclaration",
    message:
      "Don't re-export; have each importer import from the owning module.",
  },
  {
    selector: "ClassDeclaration, ClassExpression",
    message: "Write functions that take data and return results, not classes.",
  },
];

const SHARED_RULES = {
  ...js.configs.recommended.rules,
  complexity: ["error", { max: 17 }],
  "max-lines": [
    "error",
    { max: 500, skipBlankLines: true, skipComments: true },
  ],
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  eqeqeq: ["error", "always"],
  strict: "error",
  "no-extend-native": "error",
  "no-unused-vars": [
    "error",
    {
      vars: "all",
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "no-warning-comments": [
    "error",
    { terms: ["prettier-ignore"], location: "anywhere" },
  ],
  "no-restricted-syntax": ["error", MATH_RANDOM, ...STRUCTURE_RULES],
  "n/no-missing-import": "error",
  "n/no-extraneous-import": "error",
  "n/no-deprecated-api": "error",
  "n/no-unsupported-features/node-builtins": "error",
  "n/no-unsupported-features/es-syntax": "error",
  "n/no-unsupported-features/es-builtins": "error",
};

export default [
  {
    ignores: ["node_modules/**", "tmp/**"],
  },
  {
    files: JS_TARGETS,
    plugins: {
      n: nPlugin,
      "no-secrets": noSecretsPlugin,
      security: securityPlugin,
      x1: { rules: { "no-secret-logging": noSecretLogging } },
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      /*-
       * A one-line exception for a security rule is needed in the security
       * pass, but looks unused here, where those rules are off.
       */
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      ...SHARED_RULES,
      "no-console": ["warn", { allow: ["log", "warn", "error", "info"] }],
    },
  },
  {
    files: TEST_JS_TARGETS,
    rules: {
      "no-console": "off",
      "no-restricted-syntax": ["error", ...STRUCTURE_RULES],
    },
  },
  {
    /*-
     * Code-fuzzing changes a module's text as Node.js loads it, which
     * only module.registerHooks does in the process that runs the tests.
     * Every Node.js the project supports has it, but marks it
     * experimental, which the lint would otherwise refuse.
     */
    files: CODE_FUZZING_TARGETS,
    rules: {
      "n/no-unsupported-features/node-builtins": [
        "error",
        { ignores: ["module.registerHooks"] },
      ],
    },
  },
  {
    /*-
     * A program whose check of the Node.js running it must come before it
     * loads a package that an older Node.js can't parse loads that
     * package inside the function that makes the check. A static import
     * would load it first, and end the program with a SyntaxError before
     * the check could say how to start it.
     */
    files: LATE_IMPORT_TARGETS,
    rules: {
      "no-restricted-syntax": [
        "error",
        MATH_RANDOM,
        ...STRUCTURE_RULES.filter(
          (rule) => rule.selector !== "ImportExpression",
        ),
      ],
    },
  },
  {
    /*-
     * The installed files run inside nginx, through its njs module, not
     * in Node.js, so Node.js's version rules don't apply. njs supplies its
     * own globals.
     */
    files: INSTALLED_GLOBS,
    languageOptions: {
      globals: { ngx: "readonly", njs: "readonly" },
    },
    rules: {
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-unsupported-features/es-builtins": "off",
    },
  },
  prettierConfig,
];
