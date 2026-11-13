/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/judge.js
 * @description
 * The upgrade check's decisions, kept apart from its actions: whether
 * this machine is one the check can run on, and whether nginx came
 * through the upgrade as it should. Both are pure, so tests can feed
 * them any state.
 */

/** The oldest systemd the tool supports: `systemd-creds` arrived in 250. */
const MIN_SYSTEMD_VERSION = 250;

/**
 * Lists what stops the check from running on this machine.
 * @param {object} facts  What the check read about the machine.
 * @param {boolean} facts.isRoot  Whether it runs as root.
 * @param {Map<string, string>} facts.osRelease  `/etc/os-release`.
 * @param {number|null} facts.systemdVersion  systemd's major version.
 * @param {string|null} facts.nginxVersion  The installed nginx, if any.
 * @returns {string[]} One message per problem; none when it can run.
 */
export function machineProblems(facts) {
  const problems = [];
  if (facts.isRoot) {
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
  if (version === null || version < MIN_SYSTEMD_VERSION) {
    problems.push(
      `systemd is ${version ?? "of an unknown version"}; the tool needs ` +
        `${MIN_SYSTEMD_VERSION} or newer.`,
    );
  }
  if (facts.nginxVersion !== null) {
    problems.push(
      `nginx ${facts.nginxVersion} is already installed. This check ` +
        "installs and removes nginx itself, so it runs only before nginx " +
        "is installed.",
    );
  }
  return problems;
}

/**
 * Lists how nginx failed to come through the upgrade.
 * @param {object} seen  What the check saw before and after.
 * @param {Map<string, string>} seen.before  nginx.service's state before.
 * @param {Map<string, string>} seen.after  Its state after.
 * @param {string} seen.programAfter  The program the main process runs.
 * @param {boolean} seen.oldMainRunning  Whether the old main process is
 *   still running.
 * @param {string} seen.gateAfter  What the gate page says after.
 * @param {string|null} seen.installedVersion  The installed nginx.
 * @param {string} seen.expectedVersion  The version upgraded to.
 * @returns {string[]} One message per failure; none when it passed.
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
        "the hand-over, so without a saved password nginx would be locked.",
    );
  }
  if (seen.after.get("MainPID") === seen.before.get("MainPID")) {
    problems.push(
      "nginx's main process didn't change, so the new nginx never took over.",
    );
  }
  if (seen.programAfter !== "/usr/sbin/nginx") {
    problems.push(
      `nginx's main process runs ${seen.programAfter}, not the newly ` +
        "installed /usr/sbin/nginx.",
    );
  }
  if (seen.oldMainRunning) {
    problems.push("The old nginx main process is still running.");
  }
  if (seen.gateAfter === "locked") {
    problems.push(
      "After the upgrade the gate page says locked: the api key didn't " +
        "carry over.",
    );
  } else if (seen.gateAfter !== "unlocked") {
    problems.push(
      "After the upgrade the gate page never said unlocked; its last " +
        `answer was ${seen.gateAfter}.`,
    );
  }
  if (seen.installedVersion !== seen.expectedVersion) {
    problems.push(
      `nginx ${seen.installedVersion ?? "(none)"} is installed, not ` +
        `${seen.expectedVersion}.`,
    );
  }
  return problems;
}
