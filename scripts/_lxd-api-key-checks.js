/**
 * @file scripts/_lxd-api-key-checks.js
 * @description
 * The api keys' checks of the LXD system test's apply phase: the keys a
 * command shows, a key's answer from nginx, the password systemd-creds
 * holds, add-api-key and remove-api-key, the connections a removed key
 * held open, and undo-apply answered no, which keeps the keys for the
 * next apply. Never on a validator.
 */

import { spawn } from "node:child_process";
import { EMAIL_PROMPT } from "../x1-validator-private-rpc/src/cli/add-api-key.js";
import {
  PASSWORD_CREDENTIAL,
  PASSWORD_PROMPT,
  SAVE_PASSWORD_QUESTION,
} from "../x1-validator-private-rpc/src/cli/apply-key.js";
import { hashedApiKeysPathOf } from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import { REMOVE_KEY_PROMPT } from "../x1-validator-private-rpc/src/cli/remove-api-key.js";
import { WORKER_SHUTDOWN_TIMEOUT_SECONDS } from "../x1-validator-private-rpc/src/cli/render-nginx.js";
import { KEYS_AND_PASSWORD_QUESTION } from "../x1-validator-private-rpc/src/cli/undo-apply.js";
import { isApiKey } from "../x1-validator-private-rpc/src/lib/api-key.js";
import {
  AFFIRM_DISCLAIMER,
  asRootCaptured,
  asUserArgs,
  existingPaths,
  GUEST_HOME,
  GUEST_PROJECT,
} from "./_lxd.js";

/** The probe of the connections a key holds open through its removal. */
const PROBE = `${GUEST_PROJECT}/x1-validator-private-rpc/test/helpers/reload-probe.js`;

/** How long the probe may run in all, its waits included. */
const PROBE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * @typedef {object} Guest  What the checks work with in the container.
 * @property {string} name  The container.
 * @property {string} cli  The tool's command there.
 * @property {string} hostname  The rpc's hostname.
 * @property {string} ca  The roots curl trusts there.
 * @property {string} password  The test's password.
 * @property {(command: string, answers: [string, string][]) =>
 *   Promise<{code: number, output: string}>} answer  Runs a command in a
 *   terminal, and answers its prompts.
 * @property {(args: string[]) => number} tool  Runs one of the tool's
 *   commands, and gives its exit code.
 * @property {(what: string, holds: boolean) => void} expect  Checks one
 *   fact, collecting a failure.
 */

/**
 * Finds the api keys in the urls a command printed, in order.
 * @param {Guest} guest  The container.
 * @param {string} output  What the command printed.
 * @returns {string[]}
 */
export function keysIn(guest, output) {
  const start = `https://${guest.hostname}/`;
  return output
    .split(/\s+/)
    .filter((word) => word.startsWith(start))
    .map((word) => word.slice(start.length))
    .filter((rest) => isApiKey(rest));
}

/**
 * Asks nginx for the rpc's health with a key, as root in the container,
 * until the answer has the status wanted or ten seconds pass, since a
 * reload of nginx takes a moment to take a new list of keys.
 * @param {Guest} guest  The container.
 * @param {string} key  The api key.
 * @param {string} wanted  The http status wanted, such as "200".
 * @returns {boolean} Whether the answer had it.
 */
export function answersWith(guest, key, wanted) {
  const one = `curl -s -o /dev/null -w "%{http_code}" --cacert ${guest.ca} https://${guest.hostname}/${key}/health`;
  const asked = asRootCaptured(guest.name, [
    "sh",
    "-c",
    `for i in $(seq 1 40); do code=$(${one}); [ "$code" = ${wanted} ] && break; sleep 0.25; done; printf %s "$code"`,
  ]);
  return asked.stdout === wanted;
}

/**
 * Tells whether a command's output shows it asking for the password, or
 * whether to save it.
 * @param {string} output  What the command printed.
 * @returns {boolean}
 */
export function asksForPassword(output) {
  // The known password's prompt ends the new one's too.
  return (
    output.includes(PASSWORD_PROMPT) || output.includes(SAVE_PASSWORD_QUESTION)
  );
}

/**
 * Checks that systemd-creds holds the password apply saved, by
 * decrypting it as root. The test's password never reaches the output.
 * @param {Guest} guest  The container.
 * @param {object} settings  The settings the tool loads there.
 */
export function checkSavedPassword(guest, settings) {
  const decrypted = asRootCaptured(guest.name, [
    "systemd-creds",
    "decrypt",
    `--name=${PASSWORD_CREDENTIAL}`,
    settings.passwordCredentialPath,
    "-",
  ]);
  guest.expect(
    "systemd-creds holds the password apply saved",
    decrypted.status === 0 && decrypted.stdout === guest.password,
  );
}

/**
 * Reads the json a program printed on its last line.
 * @param {string} output  What it printed.
 * @returns {object} The json, or an empty object when the last line
 *   isn't json.
 */
function lastJson(output) {
  const last = output.trim().split("\n").at(-1);
  try {
    return JSON.parse(last);
  } catch {
    return {};
  }
}

/**
 * Holds a kept-alive, an http/2 and a websocket connection open with a
 * key, through the reload of its removal. Then it checks that neither of
 * the first two answers for the key, and that the websocket closes
 * within the old worker's time limit.
 * @param {Guest} guest  The container.
 * @param {string} key  The key, which works until the removal.
 * @param {() => Promise<{code: number, output: string}>} remove  Removes
 *   the key.
 * @returns {Promise<{code: number, output: string}>} What remove gave.
 */
async function probeRemoval(guest, key, remove) {
  const command = ["node", PROBE, guest.hostname, key, guest.ca];
  const args = asUserArgs(guest.name, command);
  const probe = spawn("lxc", args, { stdio: ["pipe", "pipe", "inherit"] });
  const killer = setTimeout(() => probe.kill(), PROBE_TIMEOUT_MS);
  let output = "";
  const ended = new Promise((resolve) => probe.on("close", resolve));
  const ready = await new Promise((resolve) => {
    probe.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) {
        resolve(true);
      }
    });
    probe.on("close", () => resolve(false));
  });
  const removed =
    ready === true ? await remove() : { code: 1, output: "no probe" };
  probe.stdin.end("removed\n");
  await ended;
  clearTimeout(killer);
  const report = lastJson(output);
  const closedMs = report.websocketClosedAfterMs;
  const limitMs = (WORKER_SHUTDOWN_TIMEOUT_SECONDS + 5) * 1000;
  const closedInTime =
    Number.isInteger(closedMs) && closedMs >= 0 && closedMs <= limitMs;
  guest.expect(
    "a removed key gets no answer on a kept-alive or http/2 connection, and its open websocket closes within the old worker's time limit",
    report.keepAlive === "closed" &&
      report.http2 === "closed" &&
      closedInTime === true,
  );
  return removed;
}

/**
 * Adds two keys with an email, checks that both work, removes the first
 * of them, and checks that it gets 403 while the others still work.
 * @param {Guest} guest  The container.
 * @param {string} key  The first key, which apply made.
 * @returns {Promise<string>} The second key added, which stays, or ""
 *   when add-api-key failed.
 */
export async function checkAddAndRemove(guest, key) {
  const added = await guest.answer(`node ${guest.cli} add-api-key --count 2`, [
    AFFIRM_DISCLAIMER,
    [PASSWORD_PROMPT, `${guest.password}\n`],
    [EMAIL_PROMPT, "you@example.com\n"],
  ]);
  const [second, third] = keysIn(guest, added.output);
  const made = added.code === 0 && third !== undefined && third !== null;
  const bothWork =
    made === true &&
    answersWith(guest, second, "200") &&
    answersWith(guest, third, "200");
  guest.expect("add-api-key shows two new keys, and both work", bothWork);
  if (made === false) {
    return "";
  }
  const removed = await probeRemoval(guest, second, () =>
    guest.answer(`node ${guest.cli} remove-api-key`, [
      AFFIRM_DISCLAIMER,
      [REMOVE_KEY_PROMPT, `${second}\n`],
    ]),
  );
  const removedAlone =
    removed.code === 0 &&
    answersWith(guest, second, "403") &&
    answersWith(guest, key, "200") &&
    answersWith(guest, third, "200");
  guest.expect(
    "remove-api-key: the key removed gets 403, and the others still work",
    removedAlone,
  );
  const counted = guest.tool(["ensure-there-is-at-least-one-rpc-api-key"]);
  guest.expect("the key count check finds keys in nginx's list", counted === 0);
  return third;
}

/**
 * Answers undo-apply's question no, checks that the keys and the saved
 * password stay while nginx's list goes, then runs apply, which must
 * hand nginx the same keys, asking for no password and making no key.
 * @param {Guest} guest  The container.
 * @param {string[]} keys  The keys apply and add-api-key made, which
 *   must work again.
 * @param {object} settings  The settings the tool loads there.
 * @returns {Promise<void>}
 */
export async function checkKeepsKeys(guest, keys, settings) {
  const kept = await guest.answer(`node ${guest.cli} undo-apply`, [
    AFFIRM_DISCLAIMER,
    [KEYS_AND_PASSWORD_QUESTION, "n\n"],
  ]);
  const keysFile = hashedApiKeysPathOf(settings, GUEST_HOME);
  const there = existingPaths(guest.name, [
    keysFile,
    settings.passwordCredentialPath,
    settings.hashedApiKeysMapPath,
  ]);
  guest.expect(
    "undo-apply answered no keeps the keys and the saved password, and removes nginx's list",
    kept.code === 0 &&
      there.includes(keysFile) &&
      there.includes(settings.passwordCredentialPath) &&
      !there.includes(settings.hashedApiKeysMapPath),
  );
  const again = await guest.answer(`node ${guest.cli} apply --yes`, [
    AFFIRM_DISCLAIMER,
  ]);
  const tookKeptKeys =
    again.code === 0 &&
    !asksForPassword(again.output) &&
    keysIn(guest, again.output).length === 0 &&
    keys.every((each) => answersWith(guest, each, "200"));
  guest.expect(
    "the next apply asks for no password, makes no key, and nginx takes the kept keys",
    tookKeptKeys,
  );
}
