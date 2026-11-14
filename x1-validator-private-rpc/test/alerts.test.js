/**
 * @file x1-validator-private-rpc/test/alerts.test.js
 * @description
 * Tests which alerts ensure sends:
 *
 * - a check that turns bad alerts once
 * - the public rpc repeats after the reminder interval, the certificate
 *   daily, and nginx's outages not at all
 * - a check that turns good sends a recovery notice
 * - an unknown verdict keeps the last state
 * - the flag's restoring sends a notice of its own
 * - a check that never alerted keeps -1 as its last alert time
 * - an alert state without one is refused
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideAlerts,
  emptyAlertState,
  isAlertState,
  NEVER_ALERTED,
} from "../src/cli/alerts.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

const MINUTE_MS = 60 * 1000;
const PREFIX = "x1-validator-private-rpc on x1-rpc.example.com:";

/**
 * Runs the decision for one check's verdict, with the reminder interval
 * changed from its shipped value, so a repeat at the shipped one would
 * show.
 * @param {object} check  The check.
 * @param {object} last  The last state.
 * @param {number} now  The time.
 * @param {boolean} [flagRestored]  Whether the flag was put back.
 * @returns {{messages: string[], next: object}}
 */
function decide(check, last, now, flagRestored = false) {
  const { changed } = shippedAndChangedSettings();
  return decideAlerts({
    checks: [check],
    last,
    now,
    hostname: "x1-rpc.example.com",
    reminderMinutes: changed.exposedReminderMinutes,
    flagRestored,
  });
}

test("a public rpc alerts at once, then every reminder interval", () => {
  const { changed } = shippedAndChangedSettings();
  const minutes = changed.exposedReminderMinutes;
  const exposed = {
    name: "rpc-private",
    status: "problem",
    detail: "It listens on 0.0.0.0:8899.",
  };
  const first = decide(exposed, emptyAlertState(), 0);
  assert.deepEqual(first.messages, [
    `${PREFIX} The rpc is public. It listens on 0.0.0.0:8899.`,
  ]);
  const early = decide(exposed, first.next, (minutes - 1) * MINUTE_MS);
  const due = decide(exposed, first.next, minutes * MINUTE_MS);
  assert.deepEqual([early.messages.length, due.messages.length], [0, 1]);
});

test("nginx's outage alerts once and doesn't repeat; its end sends a recovery notice", () => {
  const down = {
    name: "nginx-active",
    status: "problem",
    detail: "nginx is inactive.",
  };
  const first = decide(down, emptyAlertState(), 0);
  assert.deepEqual(first.messages, [
    `${PREFIX} nginx is down. nginx is inactive.`,
  ]);
  assert.deepEqual(decide(down, first.next, 1000 * MINUTE_MS).messages, []);
  const up = { name: "nginx-active", status: "ok", detail: "nginx is active." };
  const recovered = decide(up, first.next, 1000 * MINUTE_MS);
  assert.deepEqual(recovered.messages, [
    `${PREFIX} Recovered: nginx is active.`,
  ]);
  assert.deepEqual(decide(up, recovered.next, 1001 * MINUTE_MS).messages, []);
});

test("the certificate repeats daily; an unknown verdict keeps the last state", () => {
  const expiring = {
    name: "certificate",
    status: "problem",
    detail: "It has 9 days left.",
  };
  const first = decide(expiring, emptyAlertState(), 0);
  assert.equal(
    decide(expiring, first.next, 23 * 60 * MINUTE_MS).messages.length,
    0,
  );
  assert.equal(
    decide(expiring, first.next, 24 * 60 * MINUTE_MS).messages.length,
    1,
  );
  const unknown = {
    name: "certificate",
    status: "unknown",
    detail: "nginx isn't running.",
  };
  const kept = decide(unknown, first.next, 5 * MINUTE_MS);
  assert.deepEqual(kept.messages, []);
  assert.deepEqual(kept.next.checks.certificate, first.next.checks.certificate);
});

test("the flag's restoring sends its own notice; pending messages stay in the state", () => {
  const last = { ...emptyAlertState(), pending: ["an older message"] };
  const fine = {
    name: "gate",
    status: "ok",
    detail: "The gate page says unlocked.",
  };
  const { messages, next } = decide(fine, last, 0, true);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0],
    /An x1console update took --private-rpc out of the start script, and ensure put it back\./,
  );
  assert.deepEqual(next.pending, ["an older message"]);
});

test("a check that never alerted keeps -1 as its last alert time, and a recovery notice counts as an alert", () => {
  const down = {
    name: "nginx-active",
    status: "problem",
    detail: "It's inactive.",
  };
  const up = { ...down, status: "ok", detail: "It runs." };
  const quiet = decide(up, emptyAlertState(), 1000);
  assert.deepEqual(quiet.next.checks["nginx-active"], {
    bad: false,
    lastAlertAt: NEVER_ALERTED,
  });
  const alerted = decide(down, quiet.next, 2000);
  const recovered = decide(up, alerted.next, 5000);
  assert.deepEqual(
    [
      alerted.next.checks["nginx-active"].lastAlertAt,
      recovered.next.checks["nginx-active"],
    ],
    [2000, { bad: false, lastAlertAt: 5000 }],
  );
  assert.equal(isAlertState(recovered.next), true);
});

test("an alert state is refused when a check lacks its last alert time, or holds a wrong one", () => {
  const good = {
    version: 1,
    checks: { gate: { bad: false, lastAlertAt: NEVER_ALERTED } },
    pending: [],
  };
  assert.equal(isAlertState(good), true);
  for (const lastAlertAt of [null, undefined, -2, 1.5]) {
    const check = { bad: false, lastAlertAt };
    const damaged = { ...good, checks: { gate: check } };
    assert.equal(isAlertState(damaged), false, String(lastAlertAt));
  }
  for (const damaged of [
    null,
    { ...good, version: 2 },
    { ...good, pending: "a message" },
    { ...good, checks: [] },
  ]) {
    assert.equal(isAlertState(damaged), false, JSON.stringify(damaged));
  }
});
