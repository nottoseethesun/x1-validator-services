/**
 * @file x1-validator-private-rpc/src/cli/alerts.js
 * @description
 * Decides which Telegram alerts ensure sends, from its checks, the state
 * it kept from the last run, and the clock. A check that turns bad
 * alerts once. Some repeat while they last. One that turns good again
 * sends a recovery notice. Which checks alert, and how often each
 * repeats, is in alertRules below.
 *
 * The flag's restoring sends a notice of its own. A check whose verdict
 * is unknown keeps its last state. Messages that couldn't be sent stay
 * pending and go first at the next run, so none is lost. Each message
 * names the hostname and the event, never a secret. The state also
 * records whether the last run's Cronitor check-in failed, for
 * heartbeat.js, the check-in's module.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The last alert time of a check that has never alerted. */
export const NEVER_ALERTED = -1;

/**
 * The notice when ensure put the flag back. It says nothing of the
 * running validator, which may have restarted without the flag: the
 * rpc-private check alerts that the rpc is public then.
 */
export const FLAG_RESTORED =
  "An x1console update took --private-rpc out of the start script, and " +
  "ensure put it back, for the validator's next start.";

/**
 * @typedef {object} CheckState  One alerting check, as the last run left
 *   it.
 * @property {boolean} bad  Whether its last verdict was a problem.
 * @property {number} lastAlertAt  When it last alerted, its recovery
 *   notice included, or NEVER_ALERTED when it never has.
 */

/**
 * @typedef {object} AlertState
 * @property {number} version  The file's format, 1.
 * @property {Object<string, CheckState>} checks  Each alerting check.
 * @property {string[]} pending  Messages not yet delivered.
 * @property {boolean} checkInFailed  Whether the last run's Cronitor
 *   check-in failed, so that under --quiet ensure logs the failures only
 *   when the check-ins start failing.
 */

/**
 * Makes the alert state of a first run.
 * @returns {AlertState}
 */
export function emptyAlertState() {
  return { version: 1, checks: {}, pending: [], checkInFailed: false };
}

/**
 * Tells whether a value is an alert state as ensure writes it, every
 * check with its last alert time.
 * @param {unknown} state  The value.
 * @returns {boolean}
 */
export function isAlertState(state) {
  const checks = state?.checks;
  const isObject =
    typeof checks === "object" && checks !== null && !Array.isArray(checks);
  return (
    state?.version === 1 &&
    Array.isArray(state.pending) &&
    isObject === true &&
    Object.values(checks).every(
      (check) =>
        typeof check?.bad === "boolean" &&
        Number.isInteger(check.lastAlertAt) &&
        check.lastAlertAt >= NEVER_ALERTED,
    )
  );
}

/**
 * Lists the alerting checks, their alerts and how often they repeat.
 * @param {number} reminderMs  How often the public-rpc alerts repeat.
 * @param {number} certificateReminderMs  How often the certificate's
 *   alert repeats.
 * @returns {Map<string, {title: string, repeatMs: number|null}>}
 */
function alertRules(reminderMs, certificateReminderMs) {
  return new Map([
    ["rpc-private", { title: "The rpc is public", repeatMs: reminderMs }],
    [
      "flag-in-script",
      {
        title:
          "--private-rpc is missing from the start script, and ensure couldn't put it back",
        repeatMs: reminderMs,
      },
    ],
    ["nginx-active", { title: "nginx is down", repeatMs: null }],
    [
      "certificate",
      {
        title: "The certificate needs attention",
        repeatMs: certificateReminderMs,
      },
    ],
  ]);
}

/**
 * Decides one check's alert, and its next state.
 * @param {import("./checks.js").Check} check  The check.
 * @param {CheckState} was  Its last state.
 * @param {{title: string, repeatMs: number|null}} rule  Its alert.
 * @param {number} now  The time now, in milliseconds.
 * @returns {{message: string|null, next: CheckState}}
 */
function decideOne(check, was, rule, now) {
  if (check.status === "unknown") {
    return { message: null, next: was };
  }
  if (check.status === "ok") {
    return {
      message: was.bad === true ? `Recovered: ${check.detail}` : null,
      next: {
        bad: false,
        lastAlertAt: was.bad === true ? now : was.lastAlertAt,
      },
    };
  }
  const due =
    was.bad === false ||
    (rule.repeatMs !== undefined &&
      rule.repeatMs !== null &&
      now - was.lastAlertAt >= rule.repeatMs);
  return due === true
    ? {
        message: `${rule.title}. ${check.detail}`,
        next: { bad: true, lastAlertAt: now },
      }
    : { message: null, next: was };
}

/**
 * Decides the run's alerts.
 * @param {object} run  What the run found.
 * @param {import("./checks.js").Check[]} run.checks  The checks.
 * @param {AlertState} run.last  The state the last run kept.
 * @param {number} run.now  The time now, in milliseconds.
 * @param {string} run.hostname  The rpc's hostname, for the messages.
 * @param {number} run.reminderMinutes  How often the public-rpc alerts
 *   repeat.
 * @param {number} run.certificateReminderHours  How often the
 *   certificate's alert repeats.
 * @param {boolean} run.flagRestored  Whether ensure put the flag back.
 * @returns {{messages: string[], next: AlertState}} The new messages,
 *   and the state to keep. The state carries over the last run's pending
 *   messages, which the new messages leave out, and whether the last
 *   run's Cronitor check-in failed, which ensure updates after its own
 *   check-in.
 */
export function decideAlerts(run) {
  const { checks, last, now, hostname, flagRestored } = run;
  const prefix = `x1-validator-private-rpc on ${hostname}:`;
  const messages = [];
  const nextChecks = {};
  const lastChecks = new Map(Object.entries(last.checks));
  const rules = alertRules(
    run.reminderMinutes * MINUTE_MS,
    run.certificateReminderHours * HOUR_MS,
  );
  for (const [name, rule] of rules) {
    const was = lastChecks.get(name) ?? {
      bad: false,
      lastAlertAt: NEVER_ALERTED,
    };
    const check = checks.find((entry) => entry.name === name);
    const decided =
      check === undefined || check === null
        ? { message: null, next: was }
        : decideOne(check, was, rule, now);
    if (decided.message !== undefined && decided.message !== null) {
      messages.push(`${prefix} ${decided.message}`);
    }
    Object.assign(nextChecks, { [name]: decided.next });
  }
  if (flagRestored === true) {
    messages.push(`${prefix} ${FLAG_RESTORED}`);
  }
  return {
    messages,
    next: {
      version: 1,
      checks: nextChecks,
      pending: last.pending,
      checkInFailed: last.checkInFailed === true,
    },
  };
}
