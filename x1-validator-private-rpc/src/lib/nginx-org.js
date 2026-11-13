/**
 * @file x1-validator-private-rpc/src/lib/nginx-org.js
 * @description
 * What the tool knows about nginx.org's packages for Ubuntu, and how it
 * reads apt's and gpg's answers about them and apt's source files that
 * name nginx.org's repository. Names that nginx.org decides
 * are constants here, not settings: its signing key's address and the
 * two fingerprints the tool trusts, its repository, the three packages,
 * and the apt files its instructions name.
 *
 * Each module package is built for one exact nginx version, which leads
 * its version string: `1.30.5+1.0.1-1~noble` is njs 1.0.1 built for
 * nginx 1.30.5. So picking a set to install means picking an nginx
 * version, then the newest build of each module for it.
 *
 * Everything here is pure, so tests feed it captured command output.
 */

export const NGINX_SIGNING_KEY_URL = "https://nginx.org/keys/nginx_signing.key";

/**
 * The fingerprints the tool requires in nginx.org's key file, and the
 * only keys it lets apt trust: the one nginx.org's instructions check,
 * and the one that signs the `noble` repository.
 */
export const PINNED_FINGERPRINTS = [
  "573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62",
  "8540A6F18833A80E9C1653A42FD21310B49F6B46",
];

export const NGINX_REPOSITORY_URL = "https://nginx.org/packages/ubuntu";

/**
 * nginx.org's stable repository for Ubuntu as apt names a source, over
 * https or, in older set-ups, plain http.
 */
const NGINX_REPOSITORY = /^https?:\/\/nginx\.org\/packages\/ubuntu\/?$/;

/**
 * Where the tool puts nginx.org's key and its apt source. apt's manual
 * keeps keys an administrator adds in /etc/apt/keyrings, and prefers the
 * deb822 `.sources` format to the one-line `.list` format.
 */
export const NGINX_KEYRING_PATH = "/etc/apt/keyrings/nginx-archive-keyring.gpg";
export const NGINX_APT_SOURCE_PATH = "/etc/apt/sources.list.d/nginx.sources";
export const NGINX_APT_PIN_PATH = "/etc/apt/preferences.d/99nginx";
export const NGINX_PACKAGES = [
  "nginx",
  "nginx-module-njs",
  "nginx-module-acme",
];

/**
 * @typedef {object} PackageVersion
 * @property {string} name  The package, such as `nginx`.
 * @property {string} version  Its version, such as `1.30.6-1~noble`.
 */

/**
 * Reads the primary keys' fingerprints from `gpg --show-keys
 * --with-colons` output. Subkeys' fingerprints are left out.
 * @param {string} text  The command's output.
 * @returns {string[]} The fingerprints, in order.
 */
export function parseGpgFingerprints(text) {
  const fingerprints = [];
  let record = "";
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === "fpr" && record === "pub") {
      fingerprints.push(fields[9]);
    }
    if (fields[0] !== "fpr") {
      record = fields[0];
    }
  }
  return fingerprints;
}

/** A whole priority, such as `900` or `-1`. */
const PRIORITY = /^-?\d+$/;

/**
 * Reads one line of `apt policy` output's version table. A version line
 * holds a version and its priority, after `***` when it is the installed
 * one. A source line, indented below its version, holds a priority and
 * the source, such as `900 https://nginx.org/packages/ubuntu noble/nginx
 * amd64 Packages`.
 * @param {string} line  The line.
 * @returns {{version?: string, source?: string}} The version a version
 *   line names, or the source a source line names; nothing for any other
 *   line.
 */
function readPolicyLine(line) {
  const fields = line.trim().split(/\s+/);
  const parts = fields[0] === "***" ? fields.slice(1) : fields;
  if (
    parts.length === 2 &&
    PRIORITY.test(parts[1]) &&
    !parts[0].endsWith(":")
  ) {
    return { version: parts[0] };
  }
  if (fields.length >= 2 && PRIORITY.test(fields[0])) {
    return { source: fields[1] };
  }
  return {};
}

/**
 * Reads `apt policy` output, keeping the versions nginx.org offers. For
 * each package apt prints its name and a colon, then every version it
 * knows, each followed by the sources that offer it.
 * @param {string} text  The command's output.
 * @returns {PackageVersion[]} nginx.org's package versions, in order.
 */
export function parseAptPolicy(text) {
  const entries = [];
  let name = null;
  let version = null;
  for (const line of text.split("\n")) {
    const { version: listed, source } = readPolicyLine(line);
    if (/^\S+:$/.test(line)) {
      name = line.slice(0, -1);
      version = null;
    } else if (listed !== undefined) {
      version = listed;
    } else if (
      source !== undefined &&
      NGINX_REPOSITORY.test(source) &&
      name !== null &&
      version !== null
    ) {
      entries.push({ name, version });
      version = null;
    }
  }
  return entries;
}

/**
 * @typedef {object} SourceEntry
 * @property {string[]} uris  The repositories the entry names.
 * @property {string[]} signedBy  What its signed-by option names: key
 *   files or fingerprints; nothing when it has no such option.
 */

/**
 * Reads the entries of an apt source file in the one-line format of
 * `.list` files: `deb` or `deb-src`, then options in brackets, if any,
 * then the repository. Text after a `#` is a comment.
 * @param {string} text  The file's text.
 * @returns {SourceEntry[]}
 */
function oneLineEntries(text) {
  return text.split("\n").flatMap((line) => {
    let rest = line.split("#")[0].trim();
    const type = rest.split(/\s+/)[0];
    if (type !== "deb" && type !== "deb-src") {
      return [];
    }
    rest = rest.slice(type.length).trim();
    let options = [];
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      options = rest.slice(1, end).split(/\s+/);
      rest = rest.slice(end + 1).trim();
    }
    const signedBy = options.find((option) => option.startsWith("signed-by="));
    return [
      {
        uris: [rest.split(/\s+/)[0]],
        signedBy:
          signedBy === undefined
            ? []
            : signedBy.slice("signed-by=".length).split(","),
      },
    ];
  });
}

/**
 * Reads the entries of an apt source file in the deb822 format of
 * `.sources` files: stanzas apart by blank lines, each made of `Name:
 * value` fields, where a line that starts with a space or a tab carries
 * on the field above. A stanza with `Enabled: no` is left out, as apt
 * leaves it out. A key written into the Signed-By field itself names no
 * key file.
 * @param {string} text  The file's text.
 * @returns {SourceEntry[]}
 */
function deb822Entries(text) {
  const stanzas = [];
  let fields = new Map();
  let name = "";
  for (const line of [...text.split("\n"), ""]) {
    if (line.trim() === "") {
      if (fields.size > 0) {
        stanzas.push(fields);
      }
      fields = new Map();
    } else if (/^\s/.test(line)) {
      fields.set(name, `${fields.get(name)} ${line.trim()}`);
    } else if (!line.startsWith("#")) {
      const colon = line.indexOf(":");
      name = line.slice(0, colon).trim().toLowerCase();
      fields.set(name, line.slice(colon + 1).trim());
    }
  }
  return stanzas
    .filter((stanza) => stanza.get("enabled")?.toLowerCase() !== "no")
    .map((stanza) => {
      const signedBy = stanza.get("signed-by") ?? "";
      return {
        uris: (stanza.get("uris") ?? "").split(/\s+/),
        signedBy: signedBy.includes("-----BEGIN")
          ? []
          : signedBy.split(/[\s,]+/),
      };
    });
}

/**
 * Lists the key files that each entry for nginx.org's repository in one
 * apt source file names in its signed-by option. A fingerprint there, or
 * a key written into the entry itself, isn't a key file.
 * @param {string} text  The file's text.
 * @param {boolean} deb822  Whether the file is in the deb822 format, as
 *   `.sources` files are, rather than the one-line format of `.list`
 *   files.
 * @returns {string[][]} For each entry naming nginx.org's repository,
 *   the absolute paths of the key files it names; empty when it names
 *   none.
 */
export function nginxOrgKeyFiles(text, deb822) {
  const entries = deb822 ? deb822Entries(text) : oneLineEntries(text);
  return entries
    .filter((entry) => entry.uris.some((uri) => NGINX_REPOSITORY.test(uri)))
    .map((entry) => entry.signedBy.filter((value) => value.startsWith("/")));
}

/**
 * Splits a version string into numbers to compare: the dotted numbers of
 * the upstream version (with a module's own version after the `+`), then
 * the package revision. The release suffix after `~` is the same for
 * every version of one repository, so it is dropped.
 * @param {string} version  Such as `1.30.5+1.0.1-1~noble`.
 * @returns {number[]}
 */
function versionNumbers(version) {
  const [withRevision] = version.split("~");
  const dash = withRevision.lastIndexOf("-");
  const upstream = dash === -1 ? withRevision : withRevision.slice(0, dash);
  const revision = dash === -1 ? "0" : withRevision.slice(dash + 1);
  return [...upstream.split(/[.+]/), revision].map((part) =>
    Number.parseInt(part, 10),
  );
}

/**
 * Compares two of nginx.org's version strings, for sorting newest first.
 * It reads nginx.org's numbering scheme alone, not every Debian version.
 * @param {string} a  A version.
 * @param {string} b  Another version.
 * @returns {number} Negative when `a` is newer, positive when `b` is.
 */
export function newestFirst(a, b) {
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (right.at(i) ?? 0) - (left.at(i) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Picks the newest build of a module for an nginx version.
 * @param {PackageVersion[]} entries  nginx.org's package versions.
 * @param {string} name  The module's package.
 * @param {string} nginxVersion  The nginx version, such as
 *   `1.30.5-1~noble`.
 * @returns {PackageVersion}
 * @throws {Error} When nginx.org has no build of the module for it.
 */
function moduleFor(entries, name, nginxVersion) {
  const upstream = nginxVersion.split("-")[0];
  const builds = entries
    .filter((entry) => entry.name === name)
    .map((entry) => entry.version)
    .filter((version) => version.startsWith(`${upstream}+`))
    .sort(newestFirst);
  if (builds.length === 0) {
    throw new Error(`nginx.org has no ${name} build for nginx ${upstream}.`);
  }
  return { name, version: builds[0] };
}

/**
 * Picks the two package sets an upgrade test needs: the newest nginx
 * with its modules, and the version before it with its modules.
 * @param {PackageVersion[]} entries  nginx.org's package versions.
 * @returns {{previous: PackageVersion[], newest: PackageVersion[]}} Each
 *   set lists nginx first, then its modules.
 * @throws {Error} When nginx.org offers fewer than two nginx versions,
 *   or lacks a module build for one of them.
 */
export function pickUpgradePair(entries) {
  const versions = [
    ...new Set(
      entries
        .filter((entry) => entry.name === "nginx")
        .map((entry) => entry.version),
    ),
  ].sort(newestFirst);
  if (versions.length < 2) {
    throw new Error(
      "nginx.org offers fewer than two nginx versions for this release, " +
        "so there is no upgrade to test.",
    );
  }
  const setFor = (nginxVersion) => [
    { name: "nginx", version: nginxVersion },
    ...NGINX_PACKAGES.slice(1).map((name) =>
      moduleFor(entries, name, nginxVersion),
    ),
  ];
  return { previous: setFor(versions[1]), newest: setFor(versions[0]) };
}
