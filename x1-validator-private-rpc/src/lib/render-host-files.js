/**
 * @file x1-validator-private-rpc/src/lib/render-host-files.js
 * @description
 * Writes out, as text, the system files the tool installs besides
 * nginx's configuration: nginx.org's apt source and pin, the start
 * wrapper systemd runs to start nginx, the systemd drop-in that points
 * nginx.service at the wrapper, and the logrotate rule for nginx's logs.
 * Every function is pure; the caller writes the text where it belongs.
 *
 * The wrapper starts nginx with the api key in its environment, never in
 * a file. It takes the key from the memory-only file that `unlock` left a
 * moment before, and deletes that file. Or, with a saved password, it
 * decrypts the key as the validator's account. It passes on only a
 * well-formed key, in the format src/lib/api-key.js gives, so a bad one
 * leaves nginx locked rather than unprotected.
 */

import { API_KEY_HEX_DIGITS } from "./api-key.js";
import { NGINX_KEYRING_PATH, NGINX_REPOSITORY_URL } from "./nginx-org.js";

/**
 * The name systemd keeps the saved password under. The password is
 * encrypted under it, and the drop-in and the start wrapper name it, so
 * all three must agree.
 */
export const PASSWORD_CREDENTIAL = "x1-validator-services-password";

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
 * Writes the start wrapper.
 * @param {object} values  What the wrapper needs.
 * @param {string} values.validatorUser  The account that owns the tool.
 * @param {string} values.nodeBin  The Node.js that runs the tool.
 * @param {string} values.toolCli  The tool's `src/cli.js`.
 * @param {string} values.nginxConfigPath  nginx's main configuration.
 * @param {string} values.keyHandOffPath  The memory-only key file.
 * @returns {string} The script's text.
 */
export function renderStartWrapper(values) {
  return `#!/bin/sh
# x1-validator-private-rpc: start nginx with the rpc api key in its
# environment, never in a file. Written by the tool; systemd runs it as root.
set -u

VALIDATOR_USER=${shellQuote(values.validatorUser)}
NODE_BIN=${shellQuote(values.nodeBin)}
TOOL_CLI=${shellQuote(values.toolCli)}
NGINX_CONF=${shellQuote(values.nginxConfigPath)}
KEY_HANDOFF=${shellQuote(values.keyHandOffPath)}
PASSWORD_CREDENTIAL="${PASSWORD_CREDENTIAL}"

key=""
if [ -f "$KEY_HANDOFF" ]; then
    # apply or unlock left the key here a moment ago.
    key=$(cat "$KEY_HANDOFF")
    rm -f "$KEY_HANDOFF"
elif [ -n "\${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/$PASSWORD_CREDENTIAL" ]; then
    # Saved password: decrypt as the validator's account, never as root.
    key=$(runuser -u "$VALIDATOR_USER" -- "$NODE_BIN" "$TOOL_CLI" decrypt-key --password-stdin \\
        < "$CREDENTIALS_DIRECTORY/$PASSWORD_CREDENTIAL") || key=""
fi

# Pass on only a well-formed key: ${API_KEY_HEX_DIGITS} lower-case hex characters.
case "$key" in
    *[!0-9a-f]*) key="" ;;
esac
if [ "\${#key}" -ne ${API_KEY_HEX_DIGITS} ]; then
    key=""
    echo "x1-validator-private-rpc: no usable api key; nginx starts locked and answers 403" >&2
fi

export X1_RPC_KEY="$key"
exec /usr/sbin/nginx -c "$NGINX_CONF"
`;
}

/**
 * Writes the systemd drop-in for nginx.service.
 * @param {object} values  What the drop-in needs.
 * @param {string} values.startWrapperPath  The start wrapper.
 * @param {string|null} values.passwordCredentialPath  The saved,
 *   encrypted password, or null when the password isn't saved.
 * @returns {string} The file's text.
 */
export function renderDropIn({ startWrapperPath, passwordCredentialPath }) {
  const lines = [
    "# x1-validator-private-rpc: systemd drop-in for nginx.service.",
    "[Service]",
    "# Start through the tool's wrapper, which puts the api key in nginx's",
    "# environment and runs nginx with the tool's own configuration.",
    "ExecStart=",
    `ExecStart=${startWrapperPath}`,
  ];
  if (passwordCredentialPath !== null) {
    lines.push(
      "# Only when the password is saved: systemd decrypts it into a memory-only",
      "# folder that only this service can read.",
      `LoadCredentialEncrypted=${PASSWORD_CREDENTIAL}:${passwordCredentialPath}`,
    );
  }
  return `${lines.join("\n")}\n`;
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
