/**
 * @file x1-validator-private-rpc/test/checks.test.js
 * @description
 * Tests ensure's judgments on captured output: ss's listeners, with an
 * interface's suffix, ipv6 and a process; the rpc held by 127.0.0.1
 * alone or not; nginx on the public address's port 443 alone or not;
 * the certificate's name and days left; and the gate page's answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  judgeCertificate,
  judgeGate,
  judgeNginxListeners,
  judgeRpcListeners,
  parseListeners,
} from "../src/cli/checks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("reads ss's listeners: address, port and process", () => {
  assert.deepEqual(
    parseListeners(
      [
        "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
        "LISTEN 0 4096 [::]:8899 [::]:*",
        'LISTEN 0 1024 0.0.0.0:8899 0.0.0.0:* users:(("tachyon-validat",pid=4242,fd=50))',
        "",
      ].join("\n"),
    ),
    [
      { address: "127.0.0.53", port: 53, pid: null },
      { address: "[::]", port: 8899, pid: null },
      { address: "0.0.0.0", port: 8899, pid: 4242 },
    ],
  );
});

test("the rpc is private only on 127.0.0.1, and unknown when nothing listens", () => {
  const at = (address, port) => ({ address, port, pid: null });
  assert.equal(
    judgeRpcListeners([at("127.0.0.1", 8899), at("127.0.0.1", 8900)], 8899)
      .status,
    "ok",
  );
  for (const exposed of [
    at("0.0.0.0", 8899),
    at("[::]", 8900),
    at("*", 8899),
    at("203.0.113.10", 8899),
  ]) {
    const check = judgeRpcListeners([at("127.0.0.1", 8899), exposed], 8899);
    assert.equal(check.status, "problem");
    assert.match(
      check.detail,
      /^The rpc listens on .*, so anyone can reach it\.$/,
    );
  }
  assert.equal(judgeRpcListeners([], 8899).status, "unknown");
});

test("nginx must hold the public address's port 443 alone", () => {
  const at = (address, port) => ({ address, port, pid: null });
  const publicIp = "203.0.113.10";
  assert.equal(judgeNginxListeners([at(publicIp, 443)], publicIp).status, "ok");
  for (const listeners of [
    [],
    [at(publicIp, 443), at("0.0.0.0", 80)],
    [at("0.0.0.0", 443)],
  ]) {
    assert.equal(judgeNginxListeners(listeners, publicIp).status, "problem");
  }
});

test("the certificate must name the hostname and have enough days left", () => {
  const values = {
    hostname: "x1-rpc.example.com",
    now: 0,
    warningDays: 14,
    failure: "",
  };
  const certificate = (days, names) => ({
    validTo: days * DAY_MS,
    altNames: names,
  });
  assert.equal(
    judgeCertificate(certificate(30, "DNS:x1-rpc.example.com"), values).status,
    "ok",
  );
  assert.deepEqual(
    judgeCertificate(certificate(13, "DNS:x1-rpc.example.com"), values),
    {
      name: "certificate",
      status: "problem",
      detail: "The certificate has 13 days left.",
    },
  );
  assert.equal(
    judgeCertificate(certificate(30, "DNS:other.example.com"), values).detail,
    "The certificate isn't for x1-rpc.example.com.",
  );
  assert.equal(
    judgeCertificate(null, { ...values, failure: "certificate has expired" })
      .detail,
    "The tls check failed: certificate has expired",
  );
});

test("the gate page: unlocked is ok, locked a problem, anything else unknown", () => {
  assert.equal(judgeGate("unlocked").status, "ok");
  assert.equal(judgeGate("locked").status, "problem");
  assert.equal(judgeGate("no answer (connect ECONNREFUSED)").status, "unknown");
});
