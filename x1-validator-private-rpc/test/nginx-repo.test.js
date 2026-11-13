/**
 * @file x1-validator-private-rpc/test/nginx-repo.test.js
 * @description
 * Tests how the tool adds nginx.org's apt repository, on a fake host:
 * the key file must hold both pinned fingerprints, only those keys reach
 * apt's keyring, files that exist are left alone, an entry for
 * nginx.org the machine already has is used only once each key file it
 * names checks out, and removal takes away exactly what was written.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  PINNED_FINGERPRINTS,
} from "../src/lib/nginx-org.js";
import {
  addNginxRepository,
  exportPinnedKeys,
  removeNginxRepository,
} from "../src/lib/nginx-repo.js";
import { createFakeHost } from "./helpers/fake-host.js";

/**
 * gpg's listing of a key file holding the given fingerprints.
 * @param {string[]} fingerprints  The primary keys' fingerprints.
 * @returns {string}
 */
function colonsFor(fingerprints) {
  return fingerprints
    .map(
      (fpr) => `pub:-:4096:1:X:1:::-:::scSC::::::23::0:\nfpr:::::::::${fpr}:`,
    )
    .join("\n");
}

/** An apt source file from nginx.org's own instructions, and its key. */
const NGINX_LIST = "/etc/apt/sources.list.d/nginx.list";
const ORG_KEYRING = "/usr/share/keyrings/nginx-archive-keyring.gpg";
const ORG_ENTRY =
  `deb [signed-by=${ORG_KEYRING}] ` +
  "http://nginx.org/packages/ubuntu noble nginx\n";

const OPTIONS = { codename: "noble", timeoutMs: 1000 };

/**
 * A fake host whose gpg finds the given fingerprints in every key file.
 * @param {string[]} fingerprints  What the key files hold.
 * @param {object} [scenario]  More of the fake's scenario.
 * @param {string} [scenario.grep]  The apt source files grep finds
 *   naming nginx.org, one per line; none unless given.
 * @returns {object}
 */
function hostWithKeys(fingerprints, { grep = "", ...extra } = {}) {
  return createFakeHost({
    respond: (call) => {
      if (call.command === "grep") {
        return { stdout: grep };
      }
      if (call.command === "gpg" && call.args.includes("--show-keys")) {
        return { stdout: colonsFor(fingerprints) };
      }
      if (call.command === "gpg" && call.args.includes("--export")) {
        return { stdout: Buffer.from("pinned keyring") };
      }
      return undefined;
    },
    httpsGet: async () => ({ status: 200, body: "-----BEGIN PGP-----" }),
    ...extra,
  });
}

test("exports the pinned keys alone, then stops gpg's helpers", () => {
  const host = hostWithKeys([...PINNED_FINGERPRINTS, "F".repeat(40)]);
  const keyring = exportPinnedKeys(host, "-----BEGIN PGP-----");
  assert.equal(keyring.toString(), "pinned keyring");
  const exported = host.calls.find((call) => call.args?.includes("--export"));
  assert.deepEqual(exported.args.slice(-2), PINNED_FINGERPRINTS);
  assert.ok(host.calls.some((call) => call.command === "gpgconf"));
});

test("refuses a key file that lacks a pinned fingerprint", () => {
  const host = hostWithKeys([PINNED_FINGERPRINTS[0]]);
  assert.throws(() => exportPinnedKeys(host, "key"), {
    message: new RegExp(`no longer holds ${PINNED_FINGERPRINTS[1]}`),
  });
  assert.ok(host.calls.some((call) => call.command === "gpgconf"));
});

test("writes the keyring, source and pin, then refreshes apt's lists", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS);
  const written = await addNginxRepository(host, {
    codename: "noble",
    timeoutMs: 1000,
  });
  assert.deepEqual(written, [
    NGINX_KEYRING_PATH,
    NGINX_APT_SOURCE_PATH,
    NGINX_APT_PIN_PATH,
  ]);
  assert.match(
    String(host.files.get(NGINX_APT_SOURCE_PATH)),
    /^Suites: noble$/m,
  );
  const last = host.calls.at(-1);
  assert.equal(last.command, "apt");
  assert.deepEqual(last.args, [
    "-o",
    "Apt::Cmd::Disable-Script-Warning=true",
    "update",
  ]);
});

/**
 * Finds the key file each gpg listing read, in order.
 * @param {object} host  The fake host.
 * @returns {string[]}
 */
function keyFilesRead(host) {
  return host.calls
    .filter((call) => call.args?.includes("--show-keys"))
    .map((call) => call.args.at(-1));
}

test("leaves files that already exist as they are, once its keyring checks out", async () => {
  const files = new Map([
    [NGINX_KEYRING_PATH, "existing"],
    [NGINX_APT_SOURCE_PATH, "existing"],
    [NGINX_APT_PIN_PATH, "existing"],
  ]);
  const host = hostWithKeys(PINNED_FINGERPRINTS, { files });
  assert.deepEqual(await addNginxRepository(host, OPTIONS), []);
  assert.equal(files.get(NGINX_KEYRING_PATH), "existing");
  assert.deepEqual(keyFilesRead(host), [NGINX_KEYRING_PATH]);
});

test("refuses its own keyring, already there, when it lacks a pinned key", async () => {
  const host = hostWithKeys([PINNED_FINGERPRINTS[1]], {
    files: new Map([[NGINX_KEYRING_PATH, "earlier"]]),
  });
  await assert.rejects(addNginxRepository(host, OPTIONS), {
    message:
      `${NGINX_KEYRING_PATH}, already on this machine, doesn't hold ` +
      `${PINNED_FINGERPRINTS[0]}, so the tool won't use it. Remove it, so ` +
      "the tool downloads nginx.org's key file again.",
  });
  assert.equal(host.files.has(NGINX_APT_SOURCE_PATH), false);
  assert.ok(host.calls.some((call) => call.command === "gpgconf"));
});

test("uses an nginx.org entry the machine already has once its key file checks out", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS, {
    grep: `${NGINX_LIST}\n`,
    files: new Map([[NGINX_LIST, ORG_ENTRY]]),
    httpsGet: async () => {
      throw new Error("the key file must not be downloaded");
    },
  });
  assert.deepEqual(await addNginxRepository(host, OPTIONS), [
    NGINX_APT_PIN_PATH,
  ]);
  assert.deepEqual(keyFilesRead(host), [ORG_KEYRING]);
  assert.equal(host.files.has(NGINX_APT_SOURCE_PATH), false);
  assert.equal(host.files.has(NGINX_KEYRING_PATH), false);
});

test("refuses an existing entry whose key file lacks a pinned key, writing nothing", async () => {
  const host = hostWithKeys([PINNED_FINGERPRINTS[0]], {
    grep: `${NGINX_LIST}\n`,
    files: new Map([[NGINX_LIST, ORG_ENTRY]]),
  });
  await assert.rejects(addNginxRepository(host, OPTIONS), {
    message:
      `${ORG_KEYRING}, which ${NGINX_LIST} names for nginx.org's ` +
      `repository, doesn't hold ${PINNED_FINGERPRINTS[1]}, so the tool ` +
      "won't use it. Replace it with nginx.org's current key file, or " +
      "remove that entry so the tool adds its own.",
  });
  assert.equal(host.files.has(NGINX_APT_PIN_PATH), false);
});

test("refuses an existing entry that names no key file", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS, {
    grep: `${NGINX_LIST}\n`,
    files: new Map([
      [NGINX_LIST, "deb http://nginx.org/packages/ubuntu noble nginx\n"],
    ]),
  });
  await assert.rejects(addNginxRepository(host, OPTIONS), {
    message: new RegExp(
      `^${NGINX_LIST} names nginx\\.org's repository without a key file ` +
        "in its signed-by option, so apt would trust every key it holds",
    ),
  });
  assert.deepEqual(keyFilesRead(host), []);
});

test("checks the key files a deb822 entry names", async () => {
  const sources = "/etc/apt/sources.list.d/nginx-org.sources";
  const host = hostWithKeys(PINNED_FINGERPRINTS, {
    grep: `${sources}\n`,
    files: new Map([
      [
        sources,
        "Types: deb\nURIs: https://nginx.org/packages/ubuntu\n" +
          "Suites: noble\nComponents: nginx\nSigned-By: /etc/apt/a.gpg\n",
      ],
    ]),
  });
  assert.deepEqual(await addNginxRepository(host, OPTIONS), [
    NGINX_APT_PIN_PATH,
  ]);
  assert.deepEqual(keyFilesRead(host), ["/etc/apt/a.gpg"]);
});

test("counts its own source file, left by an earlier run, as no other entry", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS, {
    grep: `${NGINX_APT_SOURCE_PATH}\n`,
    files: new Map([[NGINX_APT_SOURCE_PATH, "earlier"]]),
  });
  assert.deepEqual(
    await addNginxRepository(host, { codename: "noble", timeoutMs: 1000 }),
    [NGINX_KEYRING_PATH, NGINX_APT_PIN_PATH],
  );
});

test("refuses when nginx.org doesn't serve the key file", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS, {
    httpsGet: async () => ({ status: 404, body: "" }),
  });
  await assert.rejects(
    addNginxRepository(host, { codename: "noble", timeoutMs: 1000 }),
    { message: /answered http 404/ },
  );
});

test("removes exactly the files written, then refreshes apt's lists", async () => {
  const files = new Map([[NGINX_APT_PIN_PATH, "pin"]]);
  const host = createFakeHost({ respond: () => undefined, files });
  await removeNginxRepository(host, [NGINX_APT_PIN_PATH]);
  assert.equal(files.size, 0);
  assert.equal(host.calls.at(-1).command, "apt");
});

test("a failed apt update removes the files written before the error goes on", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS);
  host.sudoAsync = async () => ({
    status: 100,
    stdout: "",
    stderr: "E: Could not get lock /var/lib/apt/lists/lock",
  });
  await assert.rejects(
    addNginxRepository(host, { codename: "noble", timeoutMs: 1000 }),
    { message: /^Refreshing apt's package lists failed with exit code 100/ },
  );
  for (const filePath of [
    NGINX_KEYRING_PATH,
    NGINX_APT_SOURCE_PATH,
    NGINX_APT_PIN_PATH,
  ]) {
    assert.equal(host.files.has(filePath), false, filePath);
  }
});

test("names a file it couldn't remove again after a failure", async () => {
  const host = hostWithKeys(PINNED_FINGERPRINTS);
  host.sudoAsync = async () => ({ status: 100, stdout: "", stderr: "E: x" });
  host.removeRootFile = (filePath) => {
    if (filePath === NGINX_APT_PIN_PATH) {
      throw new Error("Removing it failed");
    }
    host.files.delete(filePath);
  };
  await assert.rejects(
    addNginxRepository(host, { codename: "noble", timeoutMs: 1000 }),
    {
      message: new RegExp(
        `E: x These files couldn't be removed again: ${NGINX_APT_PIN_PATH}\\.$`,
      ),
    },
  );
});
