/**
 * @file x1-validator-private-rpc/test/njs-key-check.test.js
 * @description
 * Tests the api-key check that nginx runs, loaded into Node.js as it is:
 * which request paths it forwards and which it refuses, the hash it
 * gives nginx's map, the url it gives the access log, with `<key>`
 * wherever a key or most of one is, and what its nginx handlers do. Its
 * copy of the key's pattern must be the one the rest of the tool uses,
 * and its hash the one the tool writes into nginx's list.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  API_KEY_HEX_DIGITS,
  API_KEY_PATTERN,
  makeApiKey,
} from "../src/lib/api-key.js";
import { hashApiKey } from "../src/lib/key-hash-map.js";
import keyCheck from "../src/njs/x1-validator-private-rpc.js";

/** A well-formed key with every hex letter in it, so case shows. */
const KEY = "0123456789abcdef".repeat(API_KEY_HEX_DIGITS / 16);

const MALFORMED_KEYS = [
  "",
  KEY.slice(0, -1),
  `${KEY}0`,
  KEY.toUpperCase(),
  `${KEY.slice(0, -1)}g`,
];

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

test("its key pattern is the tool's, so it accepts the keys apply makes", () => {
  const source = new URL(
    "../src/njs/x1-validator-private-rpc.js",
    import.meta.url,
  );
  const text = fs.readFileSync(source, "utf8");
  assert.ok(text.includes(`const KEY_PATTERN = /^${API_KEY_PATTERN}$/;`));
  assert.ok(text.includes(`const KEY_LENGTH = ${API_KEY_HEX_DIGITS};`));
  const key = makeApiKey();
  assert.equal(keyCheck.pathFor(`/${key}/health`), "/health");
});

test("its hash is the one the tool writes into nginx's list", () => {
  const key = makeApiKey();
  assert.equal(keyCheck.hashFor(`/${key}/health`), hashApiKey(key));
  assert.equal(keyCheck.keyHash(fakeRequest(`/${key}`)), hashApiKey(key));
});

test("forwards the rest of the path after a well-formed key", () => {
  assert.equal(keyCheck.pathFor(`/${KEY}`), "/");
  assert.equal(keyCheck.pathFor(`/${KEY}/`), "/");
  assert.equal(keyCheck.pathFor(`/${KEY}/health`), "/health");
  assert.equal(keyCheck.forwardPath(fakeRequest(`/${KEY}/health`)), "/health");
});

test("hashes nothing, and forwards nothing, for a path that isn't a key followed by a slash or nothing", () => {
  const paths = [
    ...MALFORMED_KEYS.map((bad) => `/${bad}/health`),
    `/${KEY}x`,
    "/",
    "/health",
  ];
  for (const uri of paths) {
    assert.equal(keyCheck.pathFor(uri), "", uri);
    assert.equal(keyCheck.hashFor(uri), "", uri);
    assert.equal(keyCheck.keyHash(fakeRequest(uri)), "", uri);
    assert.equal(keyCheck.forwardPath(fakeRequest(uri)), "", uri);
  }
});

test("the access log's url has <key> in place of anything that looks like a key, wherever it is", () => {
  const half = "a".repeat(API_KEY_HEX_DIGITS / 2);
  const cases = [
    [`/${KEY}/health`, "/<key>/health"],
    [`//${KEY}/health`, "//<key>/health"],
    [`/${KEY.slice(0, -1)}`, "/<key>"],
    [`/${KEY}0?x=1`, "/<key>?x=1"],
    [`/${KEY.toUpperCase()}/`, "/<key>/"],
    [`/?api-key=${KEY}`, "/?api-key=<key>"],
    [`/v2/${KEY}`, "/v2/<key>"],
    [`/${KEY}?api-key=${KEY}`, "/<key>?api-key=<key>"],
    [`/?id=${half}`, "/?id=<key>"],
    [`/?id=${half.slice(1)}`, `/?id=${half.slice(1)}`],
    ["/favicon.ico", "/favicon.ico"],
  ];
  for (const [uri, logged] of cases) {
    assert.equal(keyCheck.maskUri(uri), logged, uri);
    const request = { variables: { request_uri: uri } };
    assert.equal(keyCheck.loggedUri(request), logged, uri);
  }
  for (const missing of [undefined, null]) {
    const request = { variables: { request_uri: missing } };
    assert.equal(keyCheck.loggedUri(request), "");
  }
});

test("the gate page says ok, as plain text", () => {
  const request = fakeRequest("/x1-rpc-gate");
  keyCheck.gatePage(request);
  assert.deepEqual(request.returned, { status: 200, body: "ok\n" });
  assert.equal(request.headersOut["Content-Type"], "text/plain");
});
