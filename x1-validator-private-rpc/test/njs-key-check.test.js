/**
 * @file x1-validator-private-rpc/test/njs-key-check.test.js
 * @description
 * Tests the api-key check that nginx runs, loaded into Node.js as it is:
 * which request paths it forwards and which it refuses, which keys it
 * counts as usable, and what its two nginx handlers do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import keyCheck from "../src/njs/x1-validator-private-rpc.js";

const KEY = "0123456789abcdef".repeat(4);

const MALFORMED_KEYS = [
  "",
  KEY.slice(0, 63),
  `${KEY}0`,
  KEY.toUpperCase(),
  `${KEY.slice(0, 63)}g`,
];

test("forwards the rest of the path after the exact key", () => {
  assert.equal(keyCheck.pathFor(`/${KEY}`, KEY), "/");
  assert.equal(keyCheck.pathFor(`/${KEY}/`, KEY), "/");
  assert.equal(keyCheck.pathFor(`/${KEY}/health`, KEY), "/health");
});

test("refuses a path that isn't the key followed by a slash or nothing", () => {
  assert.equal(keyCheck.pathFor(`/${KEY}x`, KEY), "");
  assert.equal(keyCheck.pathFor(`/${KEY.toUpperCase()}`, KEY), "");
  assert.equal(keyCheck.pathFor(`/${KEY.slice(0, 63)}`, KEY), "");
  assert.equal(keyCheck.pathFor("/", KEY), "");
});

test("refuses every request when the key in the environment is malformed", () => {
  for (const bad of MALFORMED_KEYS) {
    assert.equal(keyCheck.pathFor(`/${bad}/health`, bad), "", bad);
    assert.equal(keyCheck.gateFor(bad), "locked", bad);
  }
  assert.equal(keyCheck.gateFor(KEY), "unlocked");
});

/**
 * Runs a function with X1_RPC_KEY set as given, then puts it back.
 * @param {string|undefined} key  The value, or undefined to unset it.
 * @param {() => void} body  The function.
 */
function withEnvKey(key, body) {
  /*-
   * TEST-ONLY global swap: the key check reads nginx's environment through
   * process.env by design, so there is no hook to pass a key in. The
   * original value is restored as soon as the body returns.
   */
  const original = process.env.X1_RPC_KEY;
  if (key === undefined) {
    delete process.env.X1_RPC_KEY;
  } else {
    process.env.X1_RPC_KEY = key;
  }
  try {
    body();
  } finally {
    if (original === undefined) {
      delete process.env.X1_RPC_KEY;
    } else {
      process.env.X1_RPC_KEY = original;
    }
  }
}

/**
 * A stand-in for nginx's request object.
 * @param {string} uri  The request's normalized path.
 * @returns {object} The request, recording what the handler returns.
 */
function fakeRequest(uri) {
  const request = { uri, headersOut: {}, returned: null };
  request.return = (status, body) => {
    request.returned = { status, body };
  };
  return request;
}

test("the gate page says unlocked with a usable key, as plain text", () => {
  withEnvKey(KEY, () => {
    const request = fakeRequest("/x1-rpc-gate");
    keyCheck.gatePage(request);
    assert.deepEqual(request.returned, { status: 200, body: "unlocked\n" });
    assert.equal(request.headersOut["Content-Type"], "text/plain");
  });
});

test("the gate page says locked when nginx holds no key", () => {
  withEnvKey(undefined, () => {
    const request = fakeRequest("/x1-rpc-gate");
    keyCheck.gatePage(request);
    assert.deepEqual(request.returned, { status: 200, body: "locked\n" });
  });
});

test("forwardPath checks the request's path against the environment's key", () => {
  withEnvKey(KEY, () => {
    assert.equal(
      keyCheck.forwardPath(fakeRequest(`/${KEY}/health`)),
      "/health",
    );
    assert.equal(keyCheck.forwardPath(fakeRequest("/health")), "");
  });
});
