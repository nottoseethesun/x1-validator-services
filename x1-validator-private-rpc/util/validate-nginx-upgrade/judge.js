/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/judge.js
 * @description
 * The upgrade check's decisions, kept apart from its actions: whether
 * this machine is one the check can run on, and whether nginx came
 * through the upgrade as it should. Both are pure, so tests can feed
 * them any state.
 */

import { GATE_PAGE_NAME } from "../../src/lib/gate-page.js";
import { MIN_SYSTEMD_VERSION } from "../../src/lib/systemd.js";

/**
 * Lists what stops the check from running on this machine.
 * @param {object} facts  What the check read about the machine.
 * @param {boolean} facts.isRoot  Whether it runs as root.
 * @param {Map<string, string>} facts.osRelease  `/etc/os-release`.
 * @param {number|null} facts.systemdVersion  systemd's major version.
 * @param {string|null} facts.nginxVersion  The installed nginx, if any.
 * @returns {string[]} One message per problem, or none when it can run.
 */
export function machineProblems(facts) {
  const problems = [];
  if (facts.isRoot === true) {
    problems.push(
      "Run this as the validator's account, not as root or with sudo. It " +
        "asks for sudo itself when it needs it.",
    );
  }
  const id = facts.osRelease.get("ID") ?? "an unknown system";
  if (id !== "ubuntu") {
    problems.push(`This machine runs ${id}, not Ubuntu.`);
  }
  if (!facts.osRelease.has("VERSION_CODENAME")) {
    problems.push(
      "/etc/os-release names no release code name, which nginx.org's " +
        "repository line needs.",
    );
  }
  const version = facts.systemdVersion;
  if (
    version === undefined ||
    version === null ||
    version < MIN_SYSTEMD_VERSION
  ) {
    problems.push(
      `systemd is ${version ?? "of an unknown version"}, but the tool ` +
        `needs ${MIN_SYSTEMD_VERSION} or newer.`,
    );
  }
  if (facts.nginxVersion !== undefined && facts.nginxVersion !== null) {
    problems.push(
      `nginx ${facts.nginxVersion} is already installed. This check ` +
        "installs and removes nginx itself, so it runs only before nginx " +
        "is installed.",
    );
  }
  return problems;
}

/**
 * Lists how nginx's answers fell short: the gate page must say ok, a
 * request with the listed key must get 200, and one with a random key
 * 403.
 * @param {{gate: string, keyed: number, stranger: number}} answers  The
 *   gate page's answer, and the two requests' statuses, 0 for none.
 * @param {string} when  Before or after the upgrade, for the messages.
 * @returns {string[]} One message per failure, or none.
 */
export function keyProblems(answers, when) {
  const problems = [];
  if (answers.gate !== "ok") {
    problems.push(
      `${when} ${GATE_PAGE_NAME} never said ok. Its last answer was ${answers.gate}.`,
    );
  }
  if (answers.keyed === 0) {
    problems.push(`${when} a request with the listed key got no answer.`);
  } else if (answers.keyed !== 200) {
    problems.push(
      `${when} a request with the listed key got ${answers.keyed}, not ` +
        "200: nginx didn't find the key's hash in its list.",
    );
  }
  if (answers.stranger === 0) {
    problems.push(`${when} a request with a random key got no answer.`);
  } else if (answers.stranger !== 403) {
    problems.push(
      `${when} a request with a random key got ${answers.stranger}, not 403.`,
    );
  }
  return problems;
}

/**
 * Lists how nginx failed to come through the upgrade.
 * @param {object} seen  What the check saw before and after.
 * @param {Map<string, string>} seen.before  nginx.service's state before.
 * @param {Map<string, string>} seen.after  Its state after.
 * @param {string} seen.programAfter  The program the main process runs,
 *   or "" when there's none.
 * @param {boolean} seen.oldMainRunning  Whether the old main process is
 *   still running.
 * @param {{gate: string, keyed: number, stranger: number}}
 *   seen.answersAfter  How nginx answered after, as keyProblems judges.
 * @param {string|null} seen.installedVersion  The installed nginx.
 * @param {string} seen.expectedVersion  The version upgraded to.
 * @returns {string[]} One message per failure, or none when it passed.
 */
export function upgradeProblems(seen) {
  const problems = [];
  const state = seen.after.get("ActiveState");
  if (state !== "active") {
    problems.push(
      `After the upgrade nginx.service is ${state}, not active: systemd ` +
        "lost track of nginx.",
    );
  }
  if (seen.after.get("InvocationID") !== seen.before.get("InvocationID")) {
    problems.push(
      "systemd restarted nginx during the upgrade instead of following " +
        "the hand-over, so the upgrade dropped every open connection.",
    );
  }
  if (seen.after.get("MainPID") === seen.before.get("MainPID")) {
    problems.push(
      "nginx's main process didn't change, so the new nginx never took over.",
    );
  }
  if (seen.programAfter === "") {
    problems.push("After the upgrade nginx has no main process.");
  } else if (seen.programAfter !== "/usr/sbin/nginx") {
    problems.push(
      `nginx's main process runs ${seen.programAfter}, not the newly ` +
        "installed /usr/sbin/nginx.",
    );
  }
  if (seen.oldMainRunning === true) {
    problems.push("The old nginx main process is still running.");
  }
  problems.push(...keyProblems(seen.answersAfter, "After the upgrade"));
  if (seen.installedVersion !== seen.expectedVersion) {
    problems.push(
      `nginx ${seen.installedVersion ?? "(none)"} is installed, not ` +
        `${seen.expectedVersion}.`,
    );
  }
  return problems;
}
