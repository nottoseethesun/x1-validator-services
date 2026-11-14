/**
 * @file x1-validator-private-rpc/src/lib/apt.js
 * @description
 * Installs, upgrades and removes packages with apt, on the host it is
 * given. Changes run through sudo, without questions, so apt never
 * waits for an answer nobody is there to give. Reading what is
 * installed or offered needs no privileges.
 *
 * Every call runs `apt` itself, never `apt-get` or `apt-cache`. `apt`
 * warns on stderr whenever a program rather than a person runs it, so
 * each call turns that warning off, and it never ends up in an error
 * message.
 */

import { mustSucceed } from "./command-result.js";
import { parseAptPolicy } from "./nginx-org.js";

/** Turns off the warning `apt` prints when a program runs it. */
const NO_SCRIPT_WARNING = ["-o", "Apt::Cmd::Disable-Script-Warning=true"];

/**
 * Builds the arguments for `env` that run an apt command which changes
 * packages, with neither apt nor dpkg asking questions.
 * @param {string[]} args  apt's command and its arguments.
 * @returns {string[]}
 */
function withoutQuestions(args) {
  return [
    "DEBIAN_FRONTEND=noninteractive",
    "apt",
    ...NO_SCRIPT_WARNING,
    ...args,
  ];
}

/**
 * Reads the `Status Version` text `dpkg-query` prints for a package.
 * @param {string} text  Such as `install ok installed 1.30.6-1~noble`.
 * @returns {string|null} The installed version, or null when the package
 *   isn't installed.
 */
export function parseDpkgQuery(text) {
  const match = /^install ok installed (\S+)$/.exec(text.trim());
  return match === null ? null : match[1];
}

/**
 * Reads a package's installed version.
 * @param {object} host  The host.
 * @param {string} name  The package.
 * @returns {string|null} The version, or null when it isn't installed.
 */
export function installedVersion(host, name) {
  const result = host.run("dpkg-query", [
    "--show",
    "--showformat=${Status} ${Version}",
    name,
  ]);
  return result.status === 0 ? parseDpkgQuery(result.stdout) : null;
}

/**
 * Refreshes apt's package lists.
 * @param {object} host  The host.
 * @returns {Promise<void>}
 */
export async function updatePackageLists(host) {
  const updated = await host.sudoAsync("apt", [...NO_SCRIPT_WARNING, "update"]);
  mustSucceed(updated, "Refreshing apt's package lists");
}

/**
 * Lists the versions nginx.org offers of some packages.
 * @param {object} host  The host.
 * @param {string[]} names  The packages.
 * @returns {import("./nginx-org.js").PackageVersion[]}
 */
export function offeredVersions(host, names) {
  const listed = host.run("apt", [...NO_SCRIPT_WARNING, "policy", ...names]);
  const result = mustSucceed(listed, "Listing the package versions apt offers");
  return parseAptPolicy(result.stdout);
}

/**
 * Installs exact versions of some packages, or upgrades installed ones to
 * them, the way `apt upgrade` would: dpkg unpacks each package and runs
 * its own install scripts.
 * @param {object} host  The host.
 * @param {import("./nginx-org.js").PackageVersion[]} packages  The
 *   packages and versions.
 * @returns {Promise<void>}
 */
export async function installVersions(host, packages) {
  const pins = packages.map(({ name, version }) => `${name}=${version}`);
  const command = withoutQuestions([
    "install",
    "--yes",
    "--no-install-recommends",
    ...pins,
  ]);
  const installed = await host.sudoAsync("env", command);
  mustSucceed(installed, `Installing ${pins.join(" ")}`);
}

/**
 * Removes packages and their configuration files.
 * @param {object} host  The host.
 * @param {string[]} names  The packages.
 * @returns {Promise<void>}
 */
export async function purgePackages(host, names) {
  const command = withoutQuestions(["purge", "--yes", ...names]);
  const purged = await host.sudoAsync("env", command);
  mustSucceed(purged, `Removing ${names.join(" ")}`);
}

/**
 * Installs the newest versions apt offers of some packages, together, so
 * apt picks module builds that match the nginx it installs.
 * @param {object} host  The host.
 * @param {string[]} names  The packages.
 * @returns {Promise<void>}
 */
export async function installPackages(host, names) {
  const command = withoutQuestions([
    "install",
    "--yes",
    "--no-install-recommends",
    ...names,
  ]);
  const installed = await host.sudoAsync("env", command);
  mustSucceed(installed, `Installing ${names.join(" ")}`);
}
