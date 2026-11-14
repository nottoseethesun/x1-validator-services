/**
 * @file x1-validator-private-rpc/test/render-nginx.test.js
 * @description
 * Tests nginx's configuration beyond the placeholder example, which
 * examples.test.js pins: every setting it reads shows in it, never the
 * shipped value in its place; the websocket port follows the rpc port;
 * acmeEmail becomes a contact line; with --acme-staging a second issuer,
 * the staging one, serves the certificate; and the logs' mask hides a key
 * however the client wrote it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNginxConfig } from "../src/cli/render-nginx.js";
import { makeApiKey } from "../src/lib/api-key.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

/** The settings the configuration reads. */
const USED = [
  "njsModulePath",
  "acmeDirectoryUrl",
  "acmeStatePath",
  "nginxLogDir",
  "nginxWorkerPriority",
  "websocketIdleTimeoutSeconds",
  "rateLimitRequestsPerSecond",
];

/**
 * Renders the configuration with each setting changed from its shipped
 * value.
 * @param {object} [extra]  More values, such as `staging`.
 * @returns {{text: string, shipped: object, changed: object}}
 */
function renderChanged(extra = {}) {
  const { shipped, changed } = shippedAndChangedSettings();
  const text = renderNginxConfig({
    hostname: "x1-rpc.example.com",
    publicIp: "203.0.113.10",
    rpcPort: 9100,
    resolver: "127.0.0.53",
    staging: false,
    settings: changed,
    ...extra,
  });
  return { text, shipped, changed };
}

test("uses every setting it reads, never the shipped value", () => {
  const { text, shipped, changed } = renderChanged();
  for (const name of USED) {
    assert.ok(text.includes(String(changed[name])), `${name} is used`);
    if (typeof shipped[name] === "string") {
      assert.equal(text.includes(shipped[name]), false, `${name} shipped`);
    }
  }
  assert.match(text, /^ {8}websocket 127\.0\.0\.1:9101;$/m);
  assert.match(text, /^ {8}default {3}127\.0\.0\.1:9100;$/m);
  assert.doesNotMatch(text, /contact|letsencrypt-staging/);
  const rate = changed.rateLimitRequestsPerSecond;
  assert.match(
    text,
    new RegExp(
      `^ {4}limit_req_zone \\$server_name zone=x1_rpc:1m rate=${rate}r/s;$`,
      "m",
    ),
  );
  assert.match(
    text,
    new RegExp(`^ {12}limit_req zone=x1_rpc burst=${rate} nodelay;$`, "m"),
  );
  assert.match(text, /^ {12}limit_req_status 429;$/m);
});

test("acmeEmail becomes the issuer's contact, after its state path", () => {
  const { changed } = shippedAndChangedSettings();
  const text = renderNginxConfig({
    hostname: "x1-rpc.example.com",
    publicIp: "203.0.113.10",
    rpcPort: 8899,
    resolver: "127.0.0.53",
    staging: false,
    settings: { ...changed, acmeEmail: "you@example.com" },
  });
  assert.match(
    text,
    /state_path \S+;\n {8}contact you@example\.com;\n {8}accept_terms_of_service;/,
  );
});

test("the logs' mask hides a key however the client wrote it", () => {
  const { text } = renderChanged();
  const pattern = /"~([^"]+)" "\/<key>\$rest";/.exec(text)[1];
  const mask = new RegExp(pattern);
  const logged = (uri) => {
    const found = mask.exec(uri);
    return found === null ? uri : `/<key>${found.groups.rest}`;
  };
  const key = makeApiKey();
  assert.equal(logged(`/${key}/health`), "/<key>/health");
  assert.equal(logged(`//${key}/health`), "/<key>/health");
  assert.equal(logged(`/${key.slice(0, -1)}`), "/<key>");
  assert.equal(logged(`/${key}0?x=1`), "/<key>?x=1");
  assert.equal(logged(`/${key.toUpperCase()}/`), "/<key>/");
  assert.equal(logged("/favicon.ico"), "/favicon.ico");
});

test("with staging, a second issuer serves the certificate", () => {
  const { text, changed } = renderChanged({ staging: true });
  assert.match(text, /acme_issuer letsencrypt \{/);
  assert.match(text, /acme_issuer letsencrypt-staging \{/);
  assert.ok(text.includes(`uri ${changed.acmeStagingDirectoryUrl};`));
  assert.ok(text.includes(`state_path ${changed.acmeStagingStatePath};`));
  assert.match(text, /^ {8}acme_certificate letsencrypt-staging;$/m);
});
