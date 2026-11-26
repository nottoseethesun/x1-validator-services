/**
 * @file x1-validator-private-rpc/test/validate-nginx-upgrade-judge.test.js
 * @description
 * Tests the nginx upgrade check's decisions, in judge.js, and its test
 * configuration, on their own, with no run of the check:
 *
 * - a random key that gets through fails the check
 * - every reason a machine can't run the check, and every way nginx can
 *   fail the upgrade, each named
 * - the test configuration, which listens on 127.0.0.1 alone, and checks
 *   keys against the list it includes, with the real configuration's map
 *   sizes
 *
 * validate-nginx-upgrade.test.js runs the whole check.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAP_HASH_BUCKET_SIZE,
  MAP_HASH_MAX_SIZE,
} from "../src/lib/key-hash-map.js";
import {
  keyProblems,
  machineProblems,
  upgradeProblems,
} from "../util/validate-nginx-upgrade/judge.js";
import { renderTestNginxConfig } from "../util/validate-nginx-upgrade/render-test-config.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

test("a random key that gets through fails the check", () => {
  assert.deepEqual(
    keyProblems({ gate: "ok", keyed: 200, stranger: 200 }, "After the upgrade"),
    ["After the upgrade a request with a random key got 200, not 403."],
  );
  assert.deepEqual(
    keyProblems({ gate: "ok", keyed: 200, stranger: 403 }, "Before"),
    [],
  );
});

test("names every reason a machine can't run the check", () => {
  const problems = machineProblems({
    isRoot: true,
    osRelease: new Map([["ID", "debian"]]),
    systemdVersion: 249,
    nginxVersion: "1.24.0-2ubuntu7",
  });
  assert.equal(problems.length, 5);
  assert.deepEqual(
    machineProblems({
      isRoot: false,
      osRelease: new Map([
        ["ID", "ubuntu"],
        ["VERSION_CODENAME", "noble"],
      ]),
      systemdVersion: 255,
      nginxVersion: null,
    }),
    [],
  );
});

test("names every way nginx can fail the upgrade", () => {
  const before = new Map([
    ["ActiveState", "active"],
    ["InvocationID", "a"],
    ["MainPID", "1"],
  ]);
  const problems = upgradeProblems({
    before,
    after: new Map([
      ["ActiveState", "failed"],
      ["InvocationID", "b"],
      ["MainPID", "1"],
    ]),
    programAfter: "/usr/sbin/nginx (deleted)",
    oldMainRunning: true,
    answersAfter: { gate: "no answer (refused)", keyed: 0, stranger: 0 },
    installedVersion: null,
    expectedVersion: "1.30.6-1~noble",
  });
  assert.equal(problems.length, 9);
});

test("the test configuration listens on 127.0.0.1 alone, and checks keys against the list it includes", () => {
  // Changed paths, so a configuration that kept the shipped ones would show.
  const { njsModulePath, hashedApiKeysMapPath: mapPath } =
    shippedAndChangedSettings().changed;
  const config = renderTestNginxConfig({ port: 18080, njsModulePath, mapPath });
  assert.match(config, /^\s*listen 127\.0\.0\.1:18080;$/m);
  assert.match(config, /^pid \/run\/nginx\.pid;$/m);
  assert.match(config, /^\s*js_engine qjs;$/m);
  assert.ok(config.includes(`js_import x1rpc from ${njsModulePath};`), config);
  assert.match(config, /^\s*js_set \$x1_rpc_key_hash x1rpc\.keyHash;$/m);
  assert.ok(config.includes(`include ${mapPath};`), config);
  // The real configuration's sizes, without which nginx can't build it.
  assert.ok(config.includes(`map_hash_bucket_size ${MAP_HASH_BUCKET_SIZE};`));
  assert.ok(config.includes(`map_hash_max_size ${MAP_HASH_MAX_SIZE};`));
  assert.doesNotMatch(config, /^env /m);
});
