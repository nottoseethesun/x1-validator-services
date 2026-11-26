/**
 * @file x1-validator-private-rpc/test/hashed-api-keys.test.js
 * @description
 * Tests the api keys' file and nginx's list on a fake host:
 *
 * - the file's format: readable hashes, every value of a record
 *   encrypted, one salt for the file and one iv per value, PBKDF2's
 *   rounds as LP Ranger's key store uses them, and its modes
 * - a wrong password refused through passwordCheck, also with no record
 * - a damaged file refused, never written over
 * - nginx's list: one line per hash, counted the same way everywhere,
 *   readable by every account, an empty one reported, and nginx
 *   reloaded only while it runs, after its log folder is made again
 *   when it's missing
 * - the api keys' lock: held for a change, let go after it even when it
 *   fails, and refused while another command holds it
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createLog } from "../src/cli/log.js";
import {
  addRecord,
  apiKeysCount,
  apiKeyUrls,
  decryptValue,
  encryptValue,
  handListToNginx,
  KEYS_LOCKED,
  keysMapText,
  NO_API_KEY,
  newHashedApiKeys,
  openHashedApiKeys,
  PBKDF2_ITERATIONS,
  readHashedApiKeys,
  readMapCount,
  readRecord,
  reloadNginx,
  WRONG_PASSWORD,
  withApiKeysLock,
  writeHashedApiKeys,
  writeMap,
} from "../src/cli/hashed-api-keys.js";
import { makeApiKey } from "../src/lib/api-key.js";
import { countMapLines, hashApiKey, mapText } from "../src/lib/key-hash-map.js";
import {
  NGINX_LOG_DIR,
  NGINX_LOG_DIR_MODE,
  NGINX_UNIT,
} from "../src/lib/nginx-org.js";
import { createFakeHost } from "./helpers/fake-host.js";

const PASSWORD = "a long test password";
const FILE = "/home/validator/.config/x1-validator-services/keys.json";
const MAP = "/etc/nginx/x1-validator-private-rpc/keys.map";

/**
 * Makes a fake host whose nginx is running or not.
 * @param {boolean} [active]  Whether nginx is active.
 * @param {string[]} [folders]  The folders there at the start.
 * @returns {object}
 */
function fakeHost(active = false, folders = []) {
  return createFakeHost({
    respond: (call) =>
      call.command === "systemctl" && call.args[0] === "is-active"
        ? { stdout: active === true ? "active\n" : "inactive\n" }
        : undefined,
    folders,
  });
}

/**
 * Makes a file with two records, under PBKDF2's single round, for speed.
 * @returns {Promise<{keys: object, cipherKey: Buffer, apiKeys: string[]}>}
 */
async function twoRecords() {
  const { keys, cipherKey } = await newHashedApiKeys(PASSWORD, 1);
  const apiKeys = [makeApiKey(), makeApiKey()];
  addRecord(keys, cipherKey, hashApiKey(apiKeys[0]), {
    createdAtTimestampMS: 1000,
    email: "",
  });
  addRecord(keys, cipherKey, hashApiKey(apiKeys[1]), {
    createdAtTimestampMS: 2000,
    email: "you@example.com",
  });
  return { keys, cipherKey, apiKeys };
}

test("the file holds each hash readable, and every value of a record encrypted, each with its own iv", async () => {
  const host = fakeHost();
  const { keys, apiKeys } = await twoRecords();
  writeHashedApiKeys(host, FILE, keys);
  const file = JSON.parse(host.files.get(FILE));
  assert.deepEqual(
    Object.keys(file.hashedApiKeys),
    apiKeys.map((key) => hashApiKey(key)),
  );
  const values = Object.values(file.hashedApiKeys).flatMap((record) =>
    Object.values(record),
  );
  assert.equal(values.length, 4);
  for (const value of values) {
    assert.match(value, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  }
  const ivs = new Set(values.map((value) => value.split(".")[0]));
  assert.equal(ivs.size, values.length);
  assert.deepEqual(Object.keys(Object.values(file.hashedApiKeys)[0]), [
    "createdAtTimestampMS",
    "email",
  ]);
  assert.equal(host.files.get(FILE).includes("you@example.com"), false);
  assert.equal(file.kdfParams.digest, "sha512");
  assert.match(file.kdfParams.saltHex, /^[0-9a-f]{32}$/);
  assert.equal(host.modes.get(FILE), 0o600);
  assert.equal(
    host.modes.get("/home/validator/.config/x1-validator-services"),
    0o700,
  );
});

test("a new file takes PBKDF2's rounds from LP Ranger's key store", async () => {
  const { keys } = await newHashedApiKeys(PASSWORD);
  assert.equal(keys.kdfParams.iterations, PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 600000);
});

test("the password opens the records, read back as written, and a wrong one is refused, even with no record", async () => {
  const host = fakeHost();
  const { keys, apiKeys } = await twoRecords();
  writeHashedApiKeys(host, FILE, keys);
  const read = readHashedApiKeys(host, FILE);
  const cipherKey = await openHashedApiKeys(read, PASSWORD);
  assert.deepEqual(readRecord(read, cipherKey, hashApiKey(apiKeys[1])), {
    createdAtTimestampMS: 2000,
    email: "you@example.com",
  });
  const wrong = { message: WRONG_PASSWORD };
  await assert.rejects(openHashedApiKeys(read, "a wrong password"), wrong);
  const { keys: empty } = await newHashedApiKeys(PASSWORD, 1);
  await assert.rejects(openHashedApiKeys(empty, "a wrong password"), wrong);
  assert.ok(Buffer.isBuffer(await openHashedApiKeys(empty, PASSWORD)));
});

test("a value whose ciphertext changed is refused, even when it would read as another value", async () => {
  const { cipherKey } = await newHashedApiKeys(PASSWORD, 1);
  const value = encryptValue(cipherKey, "you@example.com");
  const [iv, tag, ciphertext] = value.split(".");
  /*-
   * GCM encrypts as a stream, so flipping a ciphertext's bits flips the
   * same bits of the plain text: this forgery would read as another
   * email, and only GCM's tag can tell.
   */
  const from = Buffer.from('"you@example.com"');
  const to = Buffer.from('"him@example.com"');
  const forged = Buffer.from(ciphertext, "base64url").map(
    (byte, index) => byte ^ from.at(index) ^ to.at(index),
  );
  const text = [iv, tag, Buffer.from(forged).toString("base64url")].join(".");
  assert.throws(() => decryptValue(cipherKey, text), {
    message: WRONG_PASSWORD,
  });
  assert.equal(decryptValue(cipherKey, value), "you@example.com");
});

test("a damaged file is refused, so it's never written over, and a missing one is null", async () => {
  const host = fakeHost();
  assert.equal(readHashedApiKeys(host, FILE), null);
  host.files.set(FILE, "{ not json");
  assert.throws(() => readHashedApiKeys(host, FILE), {
    message: `${FILE} isn't valid json.`,
  });
  const { keys } = await twoRecords();
  writeHashedApiKeys(host, FILE, keys);
  const good = JSON.parse(host.files.get(FILE));
  const [hash, record] = Object.entries(good.hashedApiKeys)[0];
  const damaged = [
    { ...good, version: 2 },
    { ...good, passwordCheck: "plain text" },
    { ...good, hashedApiKeys: [] },
    { ...good, hashedApiKeys: { "not a hash": record } },
    { ...good, hashedApiKeys: { [hash]: { email: record.email } } },
    { ...good, hashedApiKeys: { [hash]: { ...record, email: 7 } } },
  ];
  for (const file of damaged) {
    host.files.set(FILE, JSON.stringify(file));
    assert.throws(
      () => readHashedApiKeys(host, FILE),
      { message: `${FILE} isn't a file of api keys this tool wrote.` },
      JSON.stringify(file),
    );
  }
});

test("nginx's list has one line per hash, the same count everywhere, and a mode every account can read", async () => {
  const host = fakeHost();
  const modes = new Map();
  const writeRootFile = host.writeRootFile;
  host.writeRootFile = (filePath, content, mode) => {
    modes.set(filePath, mode);
    writeRootFile(filePath, content, mode);
  };
  const { keys, apiKeys } = await twoRecords();
  const hashes = apiKeys.map((key) => hashApiKey(key));
  assert.equal(writeMap(host, MAP, keys), 2);
  assert.equal(host.files.get(MAP), mapText(hashes));
  // The validator's account reads the list without sudo, in three
  // places: the key count check, url, and apply's key stage. So root
  // alone may change it, and every account may read it.
  assert.equal(modes.get(MAP), "0644");
  assert.equal(keysMapText(keys), `${hashes[0]} 1;\n${hashes[1]} 1;\n`);
  const written = host.calls.find((call) => call.kind === "writeRootFile");
  assert.equal(written.path, MAP);
  assert.equal(readMapCount(host, MAP), 2);
  assert.equal(readMapCount(host, `${MAP}.missing`), 0);
  assert.equal(
    countMapLines(`# a comment\n${hashes[0]} 1;\nnot a hash 1;\n`),
    1,
  );
});

test("handing nginx the list reloads a running nginx only, after making its log folder when it's missing, and reports an empty list", async () => {
  const lines = [];
  const log = createLog({
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
  });
  const { keys } = await twoRecords();
  const stopped = fakeHost(false);
  const settings = { hashedApiKeysMapPath: MAP };
  assert.equal(handListToNginx({ host: stopped, settings, log }, keys, "t"), 2);
  assert.equal(reloadNginx(stopped), false);
  const isReload = (call) =>
    call.command === "systemctl" &&
    call.args.join(" ") === `reload ${NGINX_UNIT}`;
  const isMade = (call) => call.kind === "makeRootDir";
  // A stopped nginx gets no reload, and no folder.
  assert.equal(stopped.calls.filter(isReload).length, 0);
  assert.equal(stopped.calls.some(isMade), false);
  const running = fakeHost(true);
  keys.records.clear();
  assert.equal(handListToNginx({ host: running, settings, log }, keys, "t"), 0);
  assert.equal(running.calls.filter(isReload).length, 1);
  // nginx can't open its logs in a missing folder, so it's made first,
  // as nginx.org's package makes it.
  const madeAt = running.calls.findIndex(isMade);
  assert.deepEqual(running.calls[madeAt], {
    kind: "makeRootDir",
    path: NGINX_LOG_DIR,
    mode: NGINX_LOG_DIR_MODE,
    group: undefined,
  });
  assert.ok(madeAt < running.calls.findIndex(isReload));
  assert.equal(running.files.get(MAP), "");
  assert.deepEqual(lines, [`ERR [t] ${NO_API_KEY}`]);
  const kept = fakeHost(true, [NGINX_LOG_DIR]);
  handListToNginx({ host: kept, settings, log }, keys, "t");
  assert.equal(kept.calls.filter(isReload).length, 1);
  assert.equal(kept.calls.some(isMade), false);
});

test("a change to the keys holds their lock, lets it go even when it fails, and is refused while another command holds it", async () => {
  const folder = path.dirname(FILE);
  const host = createFakeHost({ respond: () => undefined, folders: [folder] });
  const held = await withApiKeysLock(host, folder, async () =>
    host.locks.has(folder),
  );
  assert.equal(held, true);
  assert.equal(host.locks.size, 0);
  const failing = withApiKeysLock(host, folder, async () => {
    throw new Error("a failed change");
  });
  await assert.rejects(failing, { message: "a failed change" });
  assert.equal(host.locks.size, 0);
  const release = host.lockFolder(folder);
  let ran = false;
  const refused = withApiKeysLock(host, folder, async () => {
    ran = true;
  });
  await assert.rejects(refused, { message: KEYS_LOCKED });
  assert.equal(ran, false);
  release();
});

test("a key's urls are its https and wss forms, and the count reads 0 api keys, 1 api key and 2 api keys", () => {
  assert.deepEqual(apiKeyUrls("x1-rpc.example.com", "KEY"), [
    "https://x1-rpc.example.com/KEY",
    "wss://x1-rpc.example.com/KEY",
  ]);
  assert.deepEqual(
    [0, 1, 2].map((count) => apiKeysCount(count)),
    ["0 api keys", "1 api key", "2 api keys"],
  );
});
