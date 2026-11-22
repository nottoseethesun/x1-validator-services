/**
 * @file x1-validator-private-rpc/test/doc-figures.test.js
 * @description
 * Tests that the figures the feature's docs give from its settings match
 * the shipped settings and the schema. A Markdown doc can't read the
 * settings, so it types each figure, and this test does the job a build
 * step would: a changed setting fails the gate until the docs follow.
 *
 * - startScriptQuietSeconds: the README's "30 seconds as shipped", and
 *   the figures that follow from it and the cron job's minute, such as
 *   "30 to 90 seconds" and "up to 90 seconds"
 * - apiKeyCountCheckHours: the README's "every two hours, as shipped"
 * - maxApiKeys's maximum in the schema: the README's "its 500,000
 *   limit", and the architecture doc's "up to 500,000 keys"
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { readSchema } from "../src/lib/settings.js";
import { copyShippedConfig, shippedSettings } from "./helpers/config-copies.js";

/** How often the cron job runs ensure, in seconds: every minute. */
const CRON_SECONDS = 60;

/** The words the docs write small figures as, each at its own value. */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/**
 * Reads one of the feature's docs.
 * @param {string} relative  Its path from this folder.
 * @returns {string}
 */
function readDoc(relative) {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * Finds every figure a pattern captures in a text, as numbers: digits,
 * with or without commas, or a word.
 * @param {string} text  The doc.
 * @param {RegExp} pattern  A global pattern, whose groups capture
 *   figures.
 * @returns {number[][]} One list of figures for each match.
 */
function figures(text, pattern) {
  return [...text.matchAll(pattern)].map((match) =>
    match
      .slice(1)
      .map((figure) =>
        /^[\d,]+$/.test(figure)
          ? Number(figure.replaceAll(",", ""))
          : WORDS.indexOf(figure),
      ),
  );
}

test("the README's figures for how long ensure holds off follow the shipped startScriptQuietSeconds", () => {
  const quiet = shippedSettings().startScriptQuietSeconds;
  const latest = quiet + CRON_SECONDS;
  const readme = readDoc("../README.md");
  const shipped = figures(readme, /(\w+) seconds(?: ago)?,? as shipped/g);
  const ranges = figures(readme, /(\d+) to (\d+) seconds/g);
  const upTo = figures(readme, /up to (\d+) seconds/g);
  for (const found of [shipped, ranges, upTo]) {
    assert.ok(found.length > 0);
  }
  for (const [seconds] of shipped) {
    assert.equal(seconds, quiet);
  }
  for (const range of ranges) {
    assert.deepEqual(range, [quiet, latest]);
  }
  for (const [seconds] of upTo) {
    assert.equal(seconds, latest);
  }
});

test("the README's schedule of the key count check follows the shipped apiKeyCountCheckHours", () => {
  const found = figures(
    readDoc("../README.md"),
    /every (\w+) hours, as shipped/g,
  );
  assert.ok(found.length > 0);
  for (const [hours] of found) {
    assert.equal(hours, shippedSettings().apiKeyCountCheckHours);
  }
});

test("the docs' limit on the number of api keys is the schema's maximum for maxApiKeys", () => {
  const { maximum } = readSchema(copyShippedConfig().configDir).properties
    .maxApiKeys;
  const found = [
    ...figures(readDoc("../README.md"), /its ([\d,]+) limit/g),
    ...figures(
      readDoc("../docs/architecture.md"),
      /up to ([\d,]+) keys, the `maxApiKeys` limit/g,
    ),
  ];
  assert.equal(found.length, 2);
  for (const [keys] of found) {
    assert.equal(keys, maximum);
  }
});
