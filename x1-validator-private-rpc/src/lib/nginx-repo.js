/**
 * @file x1-validator-private-rpc/src/lib/nginx-repo.js
 * @description
 * Adds nginx.org's apt repository the way nginx.org's instructions say,
 * with one difference: apt trusts only the two keys the tool pins, not
 * every key in nginx.org's key file. The tool downloads the key file,
 * requires both pinned fingerprints in it, and exports only those two
 * keys into the keyring apt reads. A change at nginx.org therefore stops
 * the tool with a message instead of being trusted.
 *
 * Files that already exist are left as they are. So is an entry for
 * nginx.org's repository that the machine already has in another file,
 * for example from nginx.org's own instructions: the tool then uses that
 * entry, with whatever key it names, and adds no source or key of its
 * own, since apt refuses two entries for one repository that name
 * different key files. The function returns the files it wrote, so a
 * caller that must leave the system as it found it can remove exactly
 * those.
 */

import path from "node:path";
import { updatePackageLists } from "./apt.js";
import { mustSucceed } from "./command-result.js";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  NGINX_SIGNING_KEY_URL,
  PINNED_FINGERPRINTS,
  parseGpgFingerprints,
} from "./nginx-org.js";
import { renderAptPin, renderAptSource } from "./render-host-files.js";

/**
 * Runs gpg against a folder of its own, so the user's keyrings are never
 * touched.
 * @param {object} host  The host.
 * @param {string} home  gpg's folder.
 * @param {string[]} args  gpg's arguments.
 * @param {string} what  The step, for an error.
 * @param {{binary?: boolean}} [options]  Whether gpg prints binary data.
 * @returns {import("./command-result.js").CommandResult}
 */
function gpg(host, home, args, what, options = {}) {
  return mustSucceed(
    host.run("gpg", ["--homedir", home, "--batch", ...args], options),
    what,
  );
}

/**
 * Checks nginx.org's key file and exports the pinned keys alone.
 * @param {object} host  The host.
 * @param {string} keyText  The key file nginx.org serves.
 * @returns {Buffer} A binary keyring holding the two pinned keys.
 * @throws {Error} When the key file lacks a pinned fingerprint.
 */
export function exportPinnedKeys(host, keyText) {
  const home = host.makeTempDir();
  try {
    const keyFile = path.join(home, "nginx_signing.key");
    host.writeText(keyFile, keyText);
    const shown = gpg(
      host,
      home,
      ["--show-keys", "--with-colons", keyFile],
      "Reading nginx.org's signing key file",
    );
    const found = parseGpgFingerprints(shown.stdout);
    const missing = PINNED_FINGERPRINTS.filter((fpr) => !found.includes(fpr));
    if (missing.length > 0) {
      throw new Error(
        `nginx.org's signing key file no longer holds ${missing.join(" or ")}` +
          ", so the tool won't trust it. Check nginx.org's instructions " +
          "before going on.",
      );
    }
    gpg(host, home, ["--import", keyFile], "Importing nginx.org's keys");
    return gpg(
      host,
      home,
      ["--export", ...PINNED_FINGERPRINTS],
      "Exporting the pinned keys",
      { binary: true },
    ).stdout;
  } finally {
    host.run("gpgconf", ["--homedir", home, "--kill", "all"]);
    host.removeTempDir(home);
  }
}

/**
 * Downloads nginx.org's key file.
 * @param {object} host  The host.
 * @param {number} timeoutMs  How long to wait for nginx.org.
 * @returns {Promise<string>} The key file's text.
 * @throws {Error} When nginx.org answers with anything but the file.
 */
async function downloadSigningKey(host, timeoutMs) {
  const response = await host.httpsGet(NGINX_SIGNING_KEY_URL, timeoutMs);
  if (response.status !== 200) {
    throw new Error(
      `${NGINX_SIGNING_KEY_URL} answered http ${response.status} instead ` +
        "of the key file.",
    );
  }
  return response.body;
}

/**
 * Lists the apt source files, other than the tool's own, that already
 * name nginx.org's repository in a line that isn't a comment.
 * @param {object} host  The host.
 * @returns {string[]} The files; none when nothing else names it.
 */
function otherNginxSources(host) {
  const result = host.run("grep", [
    "--recursive",
    "--files-with-matches",
    "--no-messages",
    "--extended-regexp",
    "--include=*.list",
    "--include=*.sources",
    "^[^#]*nginx\\.org/packages/ubuntu",
    "/etc/apt/sources.list",
    "/etc/apt/sources.list.d",
  ]);
  return result.stdout
    .split("\n")
    .filter((file) => file !== "" && file !== NGINX_APT_SOURCE_PATH);
}

/**
 * Writes the keyring, the apt source and the apt pin where they are
 * missing, noting each file in `written` as soon as it exists. When
 * another file already names nginx.org's repository, only the pin can be
 * written.
 * @param {object} host  The host.
 * @param {{codename: string, timeoutMs: number}} options  The Ubuntu
 *   release's code name, and how long to wait for nginx.org.
 * @param {string[]} written  Collects the files written.
 * @returns {Promise<void>}
 */
async function writeRepositoryFiles(host, { codename, timeoutMs }, written) {
  const files = [[NGINX_APT_PIN_PATH, renderAptPin()]];
  if (otherNginxSources(host).length === 0) {
    if (!host.exists(NGINX_KEYRING_PATH)) {
      const keyText = await downloadSigningKey(host, timeoutMs);
      host.writeRootFile(
        NGINX_KEYRING_PATH,
        exportPinnedKeys(host, keyText),
        "0644",
      );
      written.push(NGINX_KEYRING_PATH);
    }
    files.unshift([NGINX_APT_SOURCE_PATH, renderAptSource(codename)]);
  }
  for (const [filePath, text] of files) {
    if (!host.exists(filePath)) {
      host.writeRootFile(filePath, text, "0644");
      written.push(filePath);
    }
  }
}

/**
 * Removes the files written before a failure.
 * @param {object} host  The host.
 * @param {string[]} written  The files.
 * @param {Error} error  The failure.
 * @returns {Error} The failure, also naming any file that couldn't be
 *   removed.
 */
function removeAfterFailure(host, written, error) {
  const stuck = [];
  for (const filePath of written) {
    try {
      host.removeRootFile(filePath);
    } catch {
      stuck.push(filePath);
    }
  }
  if (stuck.length === 0) {
    return error;
  }
  return new Error(
    `${error.message} These files couldn't be removed again: ` +
      `${stuck.join(", ")}.`,
    { cause: error },
  );
}

/**
 * Adds the keyring, the apt source and the apt pin where they are
 * missing, then refreshes apt's package lists. If a step fails, for
 * example the refresh, the files written so far are removed again before
 * the error goes on, so a failure leaves none of them behind.
 * @param {object} host  The host.
 * @param {{codename: string, timeoutMs: number}} options  The Ubuntu
 *   release's code name, and how long to wait for nginx.org.
 * @returns {Promise<string[]>} The files it wrote.
 */
export async function addNginxRepository(host, options) {
  const written = [];
  try {
    await writeRepositoryFiles(host, options, written);
    await updatePackageLists(host);
  } catch (error) {
    throw removeAfterFailure(host, written, error);
  }
  return written;
}

/**
 * Removes files `addNginxRepository` wrote, then refreshes apt's package
 * lists so nginx.org's lists go too.
 * @param {object} host  The host.
 * @param {string[]} written  The files.
 * @returns {Promise<void>}
 */
export async function removeNginxRepository(host, written) {
  for (const filePath of written) {
    host.removeRootFile(filePath);
  }
  await updatePackageLists(host);
}
