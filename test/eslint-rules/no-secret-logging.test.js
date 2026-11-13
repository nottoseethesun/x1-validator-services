/**
 * @file test/eslint-rules/no-secret-logging.test.js
 * @description
 * Tests the no-secret-logging lint rule with ESLint's RuleTester, which
 * reports each case through node:test's describe and it.
 */

import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import rule from "../../eslint-rules/no-secret-logging.js";

/*-
 * RuleTester's documented hooks for a test framework other than Mocha.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

ruleTester.run("no-secret-logging", rule, {
  valid: [
    'console.log("Loading the api key")',
    "console.log(hostname)",
    "logger.info(apiKey)",
  ],
  invalid: [
    { code: "console.log(apiKey)", errors: [{ messageId: "secret" }] },
    {
      code: "console.error(settings.password)",
      errors: [{ messageId: "secret" }],
    },
    {
      code: "console.log(`url: ${cronitorToken}`)",
      errors: [{ messageId: "secret" }],
    },
    {
      code: 'console.warn("secret: " + vaultSecret)',
      errors: [{ messageId: "secret" }],
    },
  ],
});
