/**
 * @file x1-validator-private-rpc/src/lib/systemd.js
 * @description
 * Talks to systemd through `systemctl`, on the host it is given. Reading
 * a unit's state needs no privileges; changing one runs through sudo.
 * The parsers are pure, so tests feed them captured output.
 */

import { mustSucceed } from "./command-result.js";

/**
 * Reads systemd's major version from the first line `systemctl
 * --version` prints, such as `systemd 255 (255.4-1ubuntu8)`.
 * @param {string} text  The command's output.
 * @returns {number|null} The version, or null when the output has none.
 */
export function parseSystemdVersion(text) {
  const match = /^systemd (\d+)\b/.exec(text.trim());
  return match === null ? null : Number.parseInt(match[1], 10);
}

/**
 * Reads the `name=value` lines `systemctl show` prints.
 * @param {string} text  The command's output.
 * @returns {Map<string, string>} Each property's name and value.
 */
export function parseShow(text) {
  const properties = new Map();
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) {
      properties.set(line.slice(0, equals), line.slice(equals + 1));
    }
  }
  return properties;
}

/**
 * Asks systemd for its major version.
 * @param {object} host  The host.
 * @returns {number|null} The version, or null when systemctl prints none.
 */
export function systemdVersion(host) {
  const result = mustSucceed(
    host.run("systemctl", ["--version"]),
    "Asking systemd for its version",
  );
  return parseSystemdVersion(result.stdout);
}

/**
 * Reads some of a unit's properties.
 * @param {object} host  The host.
 * @param {string} unit  The unit, such as `nginx.service`.
 * @param {string[]} names  The properties, such as `MainPID`.
 * @returns {Map<string, string>} Each property's name and value.
 */
export function showUnit(host, unit, names) {
  const result = mustSucceed(
    host.run("systemctl", ["show", unit, `--property=${names.join(",")}`]),
    `Reading the state of ${unit}`,
  );
  return parseShow(result.stdout);
}

/**
 * Runs a `systemctl` command that changes something, through sudo.
 * @param {object} host  The host.
 * @param {string[]} args  The command's arguments, such as
 *   `["mask", "nginx.service"]`.
 */
export function systemctl(host, args) {
  mustSucceed(
    host.sudo("systemctl", args),
    `Running systemctl ${args.join(" ")}`,
  );
}
