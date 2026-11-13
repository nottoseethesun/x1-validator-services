/**
 * @file x1-validator-private-rpc/test/parsers.test.js
 * @description
 * Tests the small pure helpers the host steps rely on: reading
 * `/etc/os-release`, systemd's and dpkg's output, turning a failed
 * command into an error, and waiting for an answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDpkgQuery } from "../src/lib/apt.js";
import { mustSucceed } from "../src/lib/command-result.js";
import { parseOsRelease } from "../src/lib/os-release.js";
import { pollUntil } from "../src/lib/poll.js";
import { parseShow, parseSystemdVersion } from "../src/lib/systemd.js";

test("reads /etc/os-release, with or without quotes", () => {
  const fields = parseOsRelease(
    'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_CODENAME=noble\n',
  );
  assert.equal(fields.get("PRETTY_NAME"), "Ubuntu 24.04.3 LTS");
  assert.equal(fields.get("ID"), "ubuntu");
  assert.equal(fields.get("VERSION_CODENAME"), "noble");
});

test("reads systemd's major version, or nothing", () => {
  assert.equal(parseSystemdVersion("systemd 255 (255.4-1ubuntu8)\n+PAM"), 255);
  assert.equal(parseSystemdVersion("something else"), null);
});

test("reads systemctl show's properties", () => {
  const properties = parseShow(
    "MainPID=123\nInvocationID=abc\nActiveState=active\n",
  );
  assert.equal(properties.get("MainPID"), "123");
  assert.equal(properties.get("ActiveState"), "active");
});

test("reads an installed package's version, or nothing", () => {
  assert.equal(
    parseDpkgQuery("install ok installed 1.30.6-1~noble"),
    "1.30.6-1~noble",
  );
  assert.equal(
    parseDpkgQuery("deinstall ok config-files 1.30.6-1~noble"),
    null,
  );
});

test("a failed command becomes an error naming the step and stderr", () => {
  const ok = { status: 0, stdout: "x", stderr: "" };
  assert.equal(mustSucceed(ok, "Testing"), ok);
  assert.throws(
    () =>
      mustSucceed(
        { status: 2, stdout: "", stderr: "no such unit\n" },
        "Masking",
      ),
    { message: "Masking failed with exit code 2: no such unit" },
  );
  assert.throws(() => mustSucceed({ status: 1, stdout: "", stderr: "" }, "X"), {
    message: "X failed with exit code 1.",
  });
});

/**
 * A clock that moves only when the code pauses.
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>}}
 */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

test("waiting stops at the first wanted answer", async () => {
  const answers = ["starting", "starting", "unlocked"];
  const result = await pollUntil(
    async () => answers.shift(),
    (answer) => answer === "unlocked",
    { timeoutMs: 10_000, intervalMs: 250, ...fakeClock() },
  );
  assert.deepEqual(result, { wanted: true, answer: "unlocked" });
});

test("waiting gives up when the time runs out, with the last answer", async () => {
  const clock = fakeClock();
  const result = await pollUntil(
    async () => "locked",
    (answer) => answer === "unlocked",
    { timeoutMs: 1000, intervalMs: 250, ...clock },
  );
  assert.deepEqual(result, { wanted: false, answer: "locked" });
  assert.equal(clock.now(), 1000);
});
