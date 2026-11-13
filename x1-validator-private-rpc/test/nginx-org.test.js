/**
 * @file x1-validator-private-rpc/test/nginx-org.test.js
 * @description
 * Tests how the tool reads gpg's and apt's answers about nginx.org's
 * packages, and how it picks the package sets for an upgrade.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newestFirst,
  parseAptPolicy,
  parseGpgFingerprints,
  pickUpgradePair,
  PINNED_FINGERPRINTS,
} from "../src/lib/nginx-org.js";

const COLONS = [
  "pub:-:2048:1:ABABF5BD827BD9BF62:1:::-:::scESC::::::23::0:",
  `fpr:::::::::${PINNED_FINGERPRINTS[0]}:`,
  "uid:-::::1::A::nginx signing key <signing-key@nginx.com>::::::::::0:",
  "sub:-:2048:1:1111111111111111:1:::::e::::::23:",
  "fpr:::::::::1111111111111111111111111111111111111111:",
  "pub:-:4096:1:2FD21310B49F6B46:1:::-:::scSC::::::23::0:",
  `fpr:::::::::${PINNED_FINGERPRINTS[1]}:`,
].join("\n");

const NGINX_ORG =
  "https://nginx.org/packages/ubuntu noble/nginx amd64 Packages";

const POLICY = [
  "nginx:",
  "  Installed: (none)",
  "  Candidate: 1.30.6-1~noble",
  "  Version table:",
  "     1.30.6-1~noble 900",
  `        900 ${NGINX_ORG}`,
  `        900 ${NGINX_ORG}`,
  "     1.30.5-1~noble 900",
  `        900 ${NGINX_ORG}`,
  "     1.24.0-2ubuntu7.5 500",
  "        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages",
  "        500 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages",
  "nginx-module-njs:",
  "  Installed: 1.30.5+1.0.1-1~noble",
  "  Candidate: 1.30.6+1.0.2-1~noble",
  "  Version table:",
  "     1.30.6+1.0.2-1~noble 900",
  `        900 ${NGINX_ORG}`,
  " *** 1.30.5+1.0.1-1~noble 900",
  `        900 ${NGINX_ORG}`,
  "        100 /var/lib/dpkg/status",
  "nginx-module-acme:",
  "  Installed: (none)",
  "  Candidate: 1.30.6+0.4.2-1~noble",
  "  Version table:",
  "     1.30.6+0.4.1-1~noble 900",
  `        900 ${NGINX_ORG}`,
  "     1.30.6+0.4.2-1~noble 900",
  `        900 ${NGINX_ORG}`,
  "     1.30.5+0.4.1-1~noble 900",
  `        900 ${NGINX_ORG}`,
].join("\n");

test("reads the primary keys' fingerprints and leaves out subkeys'", () => {
  assert.deepEqual(parseGpgFingerprints(COLONS), PINNED_FINGERPRINTS);
});

test("keeps nginx.org's package versions, once each, and leaves out Ubuntu's", () => {
  const entries = parseAptPolicy(POLICY);
  assert.equal(entries.length, 7);
  assert.deepEqual(entries[0], { name: "nginx", version: "1.30.6-1~noble" });
  assert.ok(entries.every((entry) => !entry.version.includes("ubuntu")));
  assert.ok(
    entries.some((entry) => entry.version === "1.30.5+1.0.1-1~noble"),
    "the installed version, marked ***, is kept",
  );
});

test("counts nginx.org's repository over plain http too, but not its mainline one", () => {
  const policy = (url) =>
    `nginx:\n     1.30.6-1~noble 900\n        900 ${url} noble/nginx amd64 Packages`;
  assert.equal(
    parseAptPolicy(policy("http://nginx.org/packages/ubuntu")).length,
    1,
  );
  assert.equal(
    parseAptPolicy(policy("https://nginx.org/packages/mainline/ubuntu")).length,
    0,
  );
});

test("sorts versions newest first, module builds included", () => {
  assert.deepEqual(
    ["1.30.5-1~noble", "1.30.10-1~noble", "1.30.6-2~noble", "1.30.6-1~noble"]
      .slice()
      .sort(newestFirst),
    ["1.30.10-1~noble", "1.30.6-2~noble", "1.30.6-1~noble", "1.30.5-1~noble"],
  );
  assert.ok(newestFirst("1.30.6+0.4.2-1~noble", "1.30.6+0.4.1-1~noble") < 0);
  assert.equal(newestFirst("1.30.6-1~noble", "1.30.6-1~noble"), 0);
});

test("picks the newest set and the one before, each with its own modules", () => {
  assert.deepEqual(pickUpgradePair(parseAptPolicy(POLICY)), {
    previous: [
      { name: "nginx", version: "1.30.5-1~noble" },
      { name: "nginx-module-njs", version: "1.30.5+1.0.1-1~noble" },
      { name: "nginx-module-acme", version: "1.30.5+0.4.1-1~noble" },
    ],
    newest: [
      { name: "nginx", version: "1.30.6-1~noble" },
      { name: "nginx-module-njs", version: "1.30.6+1.0.2-1~noble" },
      { name: "nginx-module-acme", version: "1.30.6+0.4.2-1~noble" },
    ],
  });
});

test("refuses when nginx.org offers fewer than two nginx versions", () => {
  assert.throws(
    () => pickUpgradePair([{ name: "nginx", version: "1.30.6-1~noble" }]),
    { message: /fewer than two nginx versions/ },
  );
});

test("refuses when a module has no build for an nginx version", () => {
  const entries = parseAptPolicy(POLICY).filter(
    (entry) => entry.version !== "1.30.5+0.4.1-1~noble",
  );
  assert.throws(() => pickUpgradePair(entries), {
    message: "nginx.org has no nginx-module-acme build for nginx 1.30.5.",
  });
});
