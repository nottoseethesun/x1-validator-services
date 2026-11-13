/**
 * @file eslint-security.config.js
 * @description
 * The security pass, kept apart from the main lint: `npm run
 * audit:security`, and a stage of `npm run lint` and the gate. It covers
 * the code that runs on the validator and the project's own scripts,
 * from scripts/lint-targets.js, and leaves tests out.
 *
 * Every rule of eslint-plugin-security is on. A rule may be turned off
 * only for the whole project, with a reason specific to this code
 * written here. eslint-plugin-no-secrets flags strings random enough to
 * be keys, and this project's no-secret-logging rule flags console calls
 * that pass a value named like a secret. A one-line exception is allowed
 * for a security rule alone, as `eslint-disable-next-line <rule> --
 * Safe: <reason>`, listed with its reason in docs/security.md.
 */

import noSecretsPlugin from "eslint-plugin-no-secrets";
import securityPlugin from "eslint-plugin-security";
import noSecretLogging from "./eslint-rules/no-secret-logging.js";
import { SECURITY_TARGETS } from "./scripts/lint-targets.js";

/**
 * The eslint-plugin-security rules turned off for the whole project, each
 * with the reason specific to this code. Every other rule is on.
 * @type {Record<string, string>}
 */
export const DISABLED_SECURITY_RULES = {
  "detect-non-literal-fs-filename":
    "The tool's job is to read and write files at computed paths: the " +
    "project's own files, found from each module's location; the " +
    "validator's system files, from fixed paths and checked settings; and " +
    "test folders. The rule flags every one of those calls, since it " +
    "can't tell a computed path from an outside one. No path here comes " +
    "from a network request or from a file the tool doesn't control, and " +
    "settings are checked against their schema before any is read.",
};

const ALL_SECURITY_RULES = Object.fromEntries(
  Object.keys(securityPlugin.rules).map((name) => [
    `security/${name}`,
    Object.hasOwn(DISABLED_SECURITY_RULES, name) ? "off" : "warn",
  ]),
);

export default [
  {
    ignores: ["node_modules/**", "tmp/**", "project-kickoff-documents/**"],
  },
  {
    files: SECURITY_TARGETS,
    plugins: {
      "no-secrets": noSecretsPlugin,
      security: securityPlugin,
      x1: { rules: { "no-secret-logging": noSecretLogging } },
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      ...ALL_SECURITY_RULES,
      "no-secrets/no-secrets": ["warn", { tolerance: 4.5 }],
      "x1/no-secret-logging": "warn",
    },
  },
];
