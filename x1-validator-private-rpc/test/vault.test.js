/**
 * @file x1-validator-private-rpc/test/vault.test.js
 * @description
 * Tests the vault: a secret's round trip; a wrong password and a changed
 * byte, each refused; a payload made by LP Ranger's key-store.js,
 * decrypted, with the same fields as the tool's own; a payload in
 * another format, refused; and the vault file's modes, written whole.
 * Most tests use a few PBKDF2 rounds, which the payload records, so they
 * run fast; the LP Ranger payload uses the full 600,000.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homePath } from "../src/cli/feature-paths.js";
import {
  API_KEY_SECRET,
  decryptSecret,
  emptyVault,
  encryptSecret,
  PBKDF2_ITERATIONS,
  readVault,
  writeVault,
} from "../src/cli/vault.js";
import { shippedSettings } from "./helpers/config-copies.js";
import { createFakeHost } from "./helpers/fake-host.js";

const PASSWORD = "test password, not a real one";
const KEY = "0123456789abcdef".repeat(4);
const FEW_ROUNDS = 1000;

/**
 * Finds the vault where the shipped settings put it, in the fake host's
 * home folder.
 * @param {object} host  The fake host.
 * @returns {string}
 */
function shippedVaultPath(host) {
  const { vaultPath } = shippedSettings();
  const homeDir = host.homeDir();
  return homePath(vaultPath, homeDir);
}

test("a secret comes back with the password it was encrypted with", async () => {
  const payload = await encryptSecret(KEY, PASSWORD, FEW_ROUNDS);
  assert.equal(payload.kdfParams.iterations, FEW_ROUNDS);
  assert.equal(payload.ciphertextHex.includes(KEY), false);
  assert.equal(await decryptSecret(payload, PASSWORD), KEY);
});

test("encrypts with LP Ranger's 600,000 rounds unless told otherwise", async () => {
  assert.equal(PBKDF2_ITERATIONS, 600000);
  const payload = await encryptSecret(KEY, PASSWORD);
  assert.equal(payload.kdfParams.iterations, PBKDF2_ITERATIONS);
});

test("refuses a wrong password, and a changed byte", async () => {
  const payload = await encryptSecret(KEY, PASSWORD, FEW_ROUNDS);
  const refused = {
    message: "The password is wrong, or the vault is damaged.",
  };
  await assert.rejects(decryptSecret(payload, "another password"), refused);
  const flipped =
    (payload.ciphertextHex[0] === "0" ? "1" : "0") +
    payload.ciphertextHex.slice(1);
  await assert.rejects(
    decryptSecret({ ...payload, ciphertextHex: flipped }, PASSWORD),
    refused,
  );
});

test("decrypts a payload made by LP Ranger's key store, whose fields it shares", async () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL("fixtures/lp-ranger-key-store-payload.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  assert.equal(await decryptSecret(fixture, PASSWORD), KEY);
  const own = await encryptSecret(KEY, PASSWORD, FEW_ROUNDS);
  assert.deepEqual(Object.keys(own), Object.keys(fixture));
  assert.deepEqual(Object.keys(own.kdfParams), Object.keys(fixture.kdfParams));
});

test("refuses a payload in a format it doesn't write", async () => {
  const payload = await encryptSecret(KEY, PASSWORD, FEW_ROUNDS);
  for (const changed of [
    { ...payload, cipher: "aes-256-cbc" },
    { ...payload, version: 2 },
    { ...payload, kdfParams: { ...payload.kdfParams, digest: "sha1" } },
  ]) {
    await assert.rejects(decryptSecret(changed, PASSWORD), {
      message: /in a format this tool can't read/,
    });
  }
});

test("writes the vault whole, readable by its owner alone, and reads it back", async () => {
  const host = createFakeHost({ respond: () => undefined });
  const vaultPath = shippedVaultPath(host);
  assert.equal(readVault(host, vaultPath), null);
  const vault = emptyVault();
  vault.secrets[API_KEY_SECRET] = await encryptSecret(
    KEY,
    PASSWORD,
    FEW_ROUNDS,
  );
  writeVault(host, vaultPath, vault);
  assert.equal(host.modes.get(vaultPath), 0o600);
  assert.equal(host.modes.get(path.dirname(vaultPath)), 0o700);
  assert.deepEqual(readVault(host, vaultPath), vault);
});

test("refuses a vault file that isn't one, rather than write over it", () => {
  for (const [text, message] of [
    ["{ not json", /isn't valid json/],
    ['{"version": 1, "secrets": []}', /isn't a vault this tool can read/],
    ['{"version": 2, "secrets": {}}', /isn't a vault this tool can read/],
  ]) {
    const host = createFakeHost({ respond: () => undefined });
    const vaultPath = shippedVaultPath(host);
    host.files.set(vaultPath, text);
    assert.throws(() => readVault(host, vaultPath), { message });
  }
});
