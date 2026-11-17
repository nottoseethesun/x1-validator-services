/**
 * @file x1-validator-private-rpc/test/render-nginx.test.js
 * @description
 * Tests nginx's configuration beyond the placeholder example, which
 * examples.test.js pins:
 *
 * - every setting it reads shows in it, never the shipped value in its
 *   place
 * - each request's key hash is looked up in the list it includes, in a
 *   table sized for every key the tool allows, and a request whose hash
 *   isn't there gets a 403 before the rate limit
 * - the websocket port follows the rpc port
 * - acmeEmail becomes a contact line
 * - with --acme-staging a second issuer, the staging one, serves the
 *   certificate
 * - the access log shows each url through the njs module's mask, which
 *   njs-key-check.test.js tests
 * - the keyed location writes no error log, since nginx's error lines
 *   carry the key
 * - after a reload, the old worker closes what it holds open within a
 *   time limit, websockets included
 * - a new connection has a shorter time limit to finish its handshake
 *   and send its request's header
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderNginxConfig,
  REQUEST_HEADER_TIMEOUT_SECONDS,
  WORKER_SHUTDOWN_TIMEOUT_SECONDS,
} from "../src/cli/render-nginx.js";
import {
  MAP_HASH_BUCKET_SIZE,
  MAP_HASH_MAX_SIZE,
} from "../src/lib/key-hash-map.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

/** The settings the configuration reads. */
const USED = [
  "njsModulePath",
  "hashedApiKeysMapPath",
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
  assert.match(
    text,
    new RegExp(`^worker_priority ${changed.nginxWorkerPriority};$`, "m"),
  );
});

test("each request's key hash is looked up in the list, and a hash that isn't there gets a 403", () => {
  const { text, changed } = renderChanged();
  assert.match(text, /^ {4}js_engine qjs;$/m);
  assert.match(text, /^ {4}js_set \$x1_rpc_key_hash x1rpc\.keyHash;$/m);
  assert.ok(text.includes(`map_hash_bucket_size ${MAP_HASH_BUCKET_SIZE};`));
  assert.ok(text.includes(`map_hash_max_size ${MAP_HASH_MAX_SIZE};`));
  assert.ok(
    text.includes(
      "map $x1_rpc_key_hash $x1_rpc_key_ok {\n        default 0;\n" +
        `        include ${changed.hashedApiKeysMapPath};\n    }`,
    ),
    text,
  );
  // nginx answers the 403 in its rewrite phase, before the rate limit.
  const location = text.slice(text.indexOf("location / {"));
  assert.ok(
    location.includes(
      "if ($x1_rpc_key_ok = 0) {\n                return 403;\n            }\n" +
        "            rewrite ^ $x1_rpc_path break;",
    ),
    location,
  );
  assert.doesNotMatch(text, /^env /m);
});

test("after a reload, the old worker closes what it holds open within the time limit, websockets included", () => {
  const { text } = renderChanged();
  // A main-context directive: nginx takes it nowhere else.
  const main = text.slice(0, text.indexOf("events {"));
  const line = `worker_shutdown_timeout ${WORKER_SHUTDOWN_TIMEOUT_SECONDS}s;`;
  assert.ok(main.split("\n").includes(line), main);
  // The owner's figure: a removed key's websocket ends within 10 seconds.
  assert.equal(WORKER_SHUTDOWN_TIMEOUT_SECONDS, 10);
});

test("a new connection has the time limit to finish its handshake and send its request's header", () => {
  const { text } = renderChanged();
  const http = text.slice(text.indexOf("http {"), text.indexOf("server {"));
  const line = `    client_header_timeout ${REQUEST_HEADER_TIMEOUT_SECONDS}s;`;
  assert.ok(http.split("\n").includes(line), http);
  // The owner's figure, past a real client's slowest case of about 3.
  assert.equal(REQUEST_HEADER_TIMEOUT_SECONDS, 5);
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

test("the access log shows each url through the njs module's mask, and never the url as sent", () => {
  const { text } = renderChanged();
  assert.ok(text.includes("js_set $x1_rpc_logged_uri x1rpc.loggedUri;"));
  assert.match(text, /log_format x1_rpc [^;]*"\$x1_rpc_logged_uri"/);
  assert.doesNotMatch(text, /\$request_uri/);
});

test("the keyed location writes no error log, since nginx's error lines carry the key", () => {
  const { text } = renderChanged();
  const keyed = text.slice(text.indexOf("location / {"));
  const logs = keyed.match(/^\s*error_log .*$/gm) ?? [];
  assert.deepEqual(
    logs.map((line) => line.trim()),
    ["error_log /dev/null;"],
  );
});

test("with staging, a second issuer serves the certificate", () => {
  const { text, changed } = renderChanged({ staging: true });
  assert.match(text, /acme_issuer letsencrypt \{/);
  assert.match(text, /acme_issuer letsencrypt-staging \{/);
  assert.ok(text.includes(`uri ${changed.acmeStagingDirectoryUrl};`));
  assert.ok(text.includes(`state_path ${changed.acmeStagingStatePath};`));
  assert.match(text, /^ {8}acme_certificate letsencrypt-staging;$/m);
});
