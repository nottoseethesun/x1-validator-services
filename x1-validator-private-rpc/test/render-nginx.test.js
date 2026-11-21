/**
 * @file x1-validator-private-rpc/test/render-nginx.test.js
 * @description
 * Tests nginx's configuration beyond the placeholder example, which
 * examples.test.js pins:
 *
 * - every setting it reads shows in it, never the shipped value in its
 *   place, and the hostname and address it's given show in their lines,
 *   never the example's
 * - each request's key hash is looked up in the list it includes, in a
 *   table sized for every key the tool allows, and a request whose hash
 *   isn't there gets a 403 before the rate limit
 * - the websocket port follows the rpc port
 * - acmeEmail becomes a contact line
 * - with --acme-staging a second issuer, the staging one, serves the
 *   certificate
 * - the access log shows each url through the njs module's mask, which
 *   njs-key-check.test.js tests
 * - no key reaches the access log: every server block's log uses the
 *   tool's format or is off, so does every other access log, and the
 *   format, read whole, holds only the masked url and six fields that
 *   carry no key
 * - the logs are .log files in nginx's own folder, which nginx.org's
 *   logrotate rule rotates, and the main error log stays at notice,
 *   since at info or debug nginx would write clients' keys into it
 * - every location but the gate page writes no error log, since nginx's
 *   error lines carry the key
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
import { GATE_PAGE_PATH } from "../src/lib/gate-page.js";
import { NGINX_LOG_DIR } from "../src/lib/nginx-org.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { ANOTHER_HOSTNAME } from "./helpers/fake-x1-validator.js";

/** A public address other than the example's. */
const ANOTHER_ADDRESS = "198.51.100.20";

/** The settings the configuration reads. */
const USED = [
  "njsModulePath",
  "hashedApiKeysMapPath",
  "acmeDirectoryUrl",
  "acmeStatePath",
  "nginxWorkerPriority",
  "websocketIdleTimeoutSeconds",
  "rateLimitRequestsPerSecond",
];

/**
 * The access log format's only fields: the time, the client's address,
 * the method, the masked url, the status, the bytes sent and the
 * request's duration. None carries a key.
 */
const KEYLESS_LOG_FIELDS = [
  "time_iso8601",
  "remote_addr",
  "request_method",
  "x1_rpc_logged_uri",
  "status",
  "body_bytes_sent",
  "request_time",
];

/**
 * Renders the configuration with each setting changed from its shipped
 * value, and a hostname and address other than the example's. So code
 * that wrote a shipped value, or the example's, in place of the value
 * given would fail.
 * @param {object} [extra]  More values, such as `staging`.
 * @returns {{text: string, shipped: object, changed: object}}
 */
function renderChanged(extra = {}) {
  const { shipped, changed } = shippedAndChangedSettings();
  const text = renderNginxConfig({
    hostname: ANOTHER_HOSTNAME,
    publicIp: ANOTHER_ADDRESS,
    rpcPort: 9100,
    resolver: "127.0.0.53",
    staging: false,
    settings: changed,
    ...extra,
  });
  return { text, shipped, changed };
}

test("uses every setting it reads, never the shipped value or the example's", () => {
  const { text, shipped, changed } = renderChanged();
  for (const name of USED) {
    assert.ok(text.includes(String(changed[name])), `${name} is used`);
    if (typeof shipped[name] === "string") {
      assert.equal(text.includes(shipped[name]), false, `${name} shipped`);
    }
  }
  const lines = text.split("\n");
  assert.ok(lines.includes(`        server_name ${ANOTHER_HOSTNAME};`), text);
  assert.ok(lines.includes(`        listen ${ANOTHER_ADDRESS}:443 ssl;`), text);
  assert.ok(lines.includes(`            allow ${ANOTHER_ADDRESS};`), text);
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

test("no key reaches the access log: every access log uses the tool's format or is off, and the format holds no field that carries a key", () => {
  const { text } = renderChanged();
  /*-
   * Where no access_log names a format, nginx uses its own, which writes
   * the request line as the client sent it, key and all. A server block
   * with no access_log line of its own gets that format, in nginx's own
   * access log.
   */
  const keyLeak = "would write every client's key into the access log";
  const servers = text.split(/^ {4}server \{$/m).slice(1);
  assert.ok(servers.length > 0, text);
  for (const server of servers) {
    assert.match(
      server,
      /^ {8}access_log (?:\S+ x1_rpc|off);$/m,
      `Each server block's log must name the x1_rpc format, or be off. Without either, nginx ${keyLeak}.`,
    );
  }
  for (const directive of text.match(/^ *access_log [^;]*;/gm) ?? []) {
    assert.match(
      directive.trim(),
      /^access_log (?:\S+ x1_rpc|off);$/,
      `${directive.trim()} ${keyLeak}.`,
    );
  }
  /*-
   * The format ends with a quote and a semicolon at a line's end, so a
   * semicolon inside its quotes doesn't cut it short.
   */
  const format = /log_format x1_rpc ([\s\S]*?['"]);$/m.exec(text)?.at(1) ?? "";
  const fields = [...format.matchAll(/\$\{?(\w+)/g)].map((match) => match[1]);
  assert.ok(fields.length > 0, text);
  assert.deepEqual(
    fields.filter((field) => !KEYLESS_LOG_FIELDS.includes(field)),
    [],
    `A field such as $request ${keyLeak}.`,
  );
});

test("the logs are .log files in nginx's own folder, where nginx.org's logrotate rule rotates them, and the main error log keeps no key", () => {
  const { text } = renderChanged();
  const logs = [...text.matchAll(/^\s*(?:error|access)_log (\S+?)[ ;]/gm)]
    .map((match) => match[1])
    .filter((file) => file !== "/dev/null" && file !== "off");
  assert.deepEqual(logs, [
    `${NGINX_LOG_DIR}/error.log`,
    `${NGINX_LOG_DIR}/access.log`,
  ]);
  /*-
   * Until nginx picks a location, its errors go to the main error log. At
   * info, it writes one for each client that stalls, drops or garbles its
   * request's header, with the request line as far as the client sent
   * it, key and all.
   */
  assert.ok(
    text.split("\n").includes(`error_log ${NGINX_LOG_DIR}/error.log notice;`),
    "nginx's main error log must stay at notice. At info or debug, nginx " +
      "would write clients' keys into the error log.",
  );
});

test("every location but the gate page writes no error log, since nginx's error lines carry the key", () => {
  const { text } = renderChanged();
  /*-
   * Each location ends at its own closing brace. A location with no
   * error_log line of its own writes into the main error log.
   */
  const keyed = text
    .split(/^ {8}location /m)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf("\n        }\n")))
    .filter((block) => !block.startsWith(`= ${GATE_PAGE_PATH} `));
  assert.ok(keyed.length > 0, text);
  for (const location of keyed) {
    const logs = location.match(/^\s*error_log .*$/gm) ?? [];
    assert.deepEqual(
      logs.map((line) => line.trim()),
      ["error_log /dev/null;"],
      location,
    );
  }
});

test("with staging, a second issuer serves the certificate", () => {
  const { text, changed } = renderChanged({ staging: true });
  assert.match(text, /acme_issuer letsencrypt \{/);
  assert.match(text, /acme_issuer letsencrypt-staging \{/);
  assert.ok(text.includes(`uri ${changed.acmeStagingDirectoryUrl};`));
  assert.ok(text.includes(`state_path ${changed.acmeStagingStatePath};`));
  assert.match(text, /^ {8}acme_certificate letsencrypt-staging;$/m);
});
