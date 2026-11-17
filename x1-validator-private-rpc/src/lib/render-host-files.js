/**
 * @file x1-validator-private-rpc/src/lib/render-host-files.js
 * @description
 * Writes out, as text, the system files the tool installs besides
 * nginx's configuration: nginx.org's apt source and pin, the systemd
 * drop-in that starts nginx with the tool's configuration, and the
 * logrotate rule for nginx's logs. Every function is pure. The caller
 * writes the text where it belongs.
 */

import { NGINX_KEYRING_PATH, NGINX_REPOSITORY_URL } from "./nginx-org.js";

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
 * root's.
 * @param {object} values  What the drop-in needs.
 * @param {string} values.nginxConfigPath  nginx's main configuration.
 * @returns {string} The file's text.
 */
export function renderDropIn({ nginxConfigPath }) {
  return [
    "# x1-validator-private-rpc: systemd drop-in for nginx.service.",
    "[Service]",
    "# Start nginx with the tool's own configuration, not the package's.",
    "ExecStart=",
    `ExecStart=/usr/sbin/nginx -c ${nginxConfigPath}`,
    "# Give nginx its own /dev, read-only, so reopening its logs can't hand",
    "# the machine's /dev/null to the nginx account.",
    "PrivateDevices=yes",
    "",
  ].join("\n");
}

/**
 * Writes the logrotate rule for the private rpc's nginx logs: daily,
 * compressed, keeping the configured number of days. After each rotation
 * it sends nginx USR1, as the packaged rule does, so nginx reopens its
 * logs and writes to the new files.
 * @param {object} values  What the rule needs.
 * @param {string} values.nginxLogDir  Where nginx writes the logs.
 * @param {number} values.logRetentionDays  How many days to keep.
 * @param {string} values.logrotateRulePath  Where the rule goes.
 * @returns {string} The file's text.
 */
export function renderLogrotateRule(values) {
  const { nginxLogDir, logRetentionDays, logrotateRulePath } = values;
  return `# x1-validator-private-rpc: rotate the private rpc's nginx logs daily and
# keep ${logRetentionDays} days of them. Copy to ${logrotateRulePath}
${nginxLogDir}/*.log {
    daily
    rotate ${logRetentionDays}
    missingok
    notifempty
    compress
    delaycompress
    create 0640 nginx adm
    sharedscripts
    postrotate
        if [ -f /run/nginx.pid ]; then
            kill -USR1 "$(cat /run/nginx.pid)"
        fi
    endscript
}
`;
}
