/**
 * @file x1-validator-private-rpc/src/lib/render-host-files.js
 * @description
 * Writes out, as text, the system files the tool installs besides
 * nginx's configuration: nginx.org's apt source and pin, and the systemd
 * drop-in that starts nginx with the tool's configuration. Every
 * function is pure. The caller writes the text where it belongs.
 */

import {
  NGINX_KEYRING_PATH,
  NGINX_LOG_DIR,
  NGINX_LOG_DIR_MODE,
  NGINX_REPOSITORY_URL,
} from "./nginx-org.js";

/**
 * Quotes a value for a POSIX shell, so the shell reads it as one word,
 * whatever it holds.
 * @param {string} value  The value.
 * @returns {string} The value in single quotes.
 */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes nginx.org's apt source, for one Ubuntu release, in the deb822
 * format of a `.sources` file.
 * @param {string} codename  The release's code name, such as `noble`.
 * @returns {string} The file's text.
 */
export function renderAptSource(codename) {
  return [
    "# x1-validator-private-rpc: nginx.org's stable packages for Ubuntu.",
    "Types: deb",
    `URIs: ${NGINX_REPOSITORY_URL}`,
    `Suites: ${codename}`,
    "Components: nginx",
    `Signed-By: ${NGINX_KEYRING_PATH}`,
    "",
  ].join("\n");
}

/**
 * Writes the apt pin that prefers nginx.org's packages over Ubuntu's own,
 * so the modules always match the installed nginx.
 * @returns {string} The file's text.
 */
export function renderAptPin() {
  return [
    "# x1-validator-private-rpc: prefer nginx.org's packages over Ubuntu's own,",
    "# so that the ACME and njs modules match the installed nginx.",
    "Package: *",
    "Pin: origin nginx.org",
    "Pin: release o=nginx",
    "Pin-Priority: 900",
    "",
  ].join("\n");
}

/**
 * Writes the systemd drop-in for nginx.service, which starts nginx with
 * the tool's own configuration, and with its own read-only /dev. When
 * nginx reopens its logs, its master hands each to the nginx account,
 * /dev/null among them, since the keyed location's error log goes there.
 * In nginx's own /dev that fails, and the machine's /dev/null stays
 * root's. Before each start, it makes nginx's log folder when it's
 * missing, as nginx.org's package makes it, since nginx can't start
 * without it. A folder that's there keeps its own mode.
 * @param {object} values  What the drop-in needs.
 * @param {string} values.nginxConfigPath  nginx's main configuration.
 * @returns {string} The file's text.
 */
export function renderDropIn({ nginxConfigPath }) {
  const makeLogFolder =
    `test -d ${NGINX_LOG_DIR} || ` +
    `install -d -m ${NGINX_LOG_DIR_MODE} ${NGINX_LOG_DIR}`;
  return [
    "# x1-validator-private-rpc: systemd drop-in for nginx.service.",
    "[Service]",
    "# Before each start, make nginx's log folder when it's missing, since",
    "# nginx can't start without it.",
    `ExecStartPre=/bin/sh -c '${makeLogFolder}'`,
    "# Start nginx with the tool's own configuration, not the package's.",
    "ExecStart=",
    `ExecStart=/usr/sbin/nginx -c ${nginxConfigPath}`,
    "# Give nginx its own /dev, read-only, so reopening its logs can't hand",
    "# the machine's /dev/null to the nginx account.",
    "PrivateDevices=yes",
    "",
  ].join("\n");
}
