/**
 * @file x1-validator-private-rpc/src/lib/os-release.js
 * @description
 * Reads `/etc/os-release`, the file that names the Linux distribution
 * and its release. The tool needs the distribution's id, to confirm
 * Ubuntu, and the release's code name, such as `noble`, which nginx.org's
 * repository line names.
 */

/**
 * Reads the text of `/etc/os-release` into its fields. Values may be
 * quoted; the quotes are removed.
 * @param {string} text  The file's text.
 * @returns {Map<string, string>} Each field's name and value.
 */
export function parseOsRelease(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match !== null) {
      fields.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
    }
  }
  return fields;
}
