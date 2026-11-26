/**
 * @file x1-validator-private-rpc/test/check-my-private-rpc.test.js
 * @description
 * Tests check-my-private-rpc on a stand-in host:
 *
 * - every query answered: as many queries as the settings say, one after
 *   another, each with their time limit, and a green check mark, after a
 *   line that says how many
 * - nginx refusing the key, its rate limit, an rpc it can't reach, an rpc
 *   error and answers that aren't json-rpc, each explained
 * - a name that doesn't resolve, a refused connection, an untrusted
 *   certificate and a request that gets no answer
 * - answers that aren't a hostname or an api key, with a pasted url's
 *   key kept out of the reason
 * - the real entry point's help, whose examples use each option it
 *   lists, but help, and no other
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { optionGaps } from "../../test/helpers/help-options.js";
import { makeApiKey } from "../src/lib/api-key.js";
import { maskSecret } from "../src/lib/mask-secret.js";
import { oldestNode } from "../src/lib/node-version.js";
import {
  checkingLine,
  inputProblem,
  judge,
  QUERY_METHOD,
  sendQueries,
} from "../util/check-my-private-rpc/check.js";
import { renderReport } from "../util/check-my-private-rpc/table.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { HOSTNAME } from "./helpers/fake-x1-validator.js";

/**
 * Runs the check with changed settings, on a stand-in host whose rpc
 * answers each query as told, taking 5 ms more for each query than the
 * last.
 * @param {(id: number) => {status: number, body: string}} answer  How the
 *   rpc answers a query. It may throw, as a failed request does.
 * @returns {Promise<object>} The settings, the key, what was posted, how
 *   many requests were ever open at once, the verdict and the report.
 */
async function check(answer) {
  const { changed } = shippedAndChangedSettings();
  const posted = [];
  let open = 0;
  let mostOpen = 0;
  const host = createFakeHost({
    respond: () => undefined,
    postJson: async (url, body, timeoutMs) => {
      open += 1;
      mostOpen = Math.max(mostOpen, open);
      posted.push({ url, body, timeoutMs });
      try {
        await host.sleep(5 * body.id);
        return answer(body.id);
      } finally {
        open -= 1;
      }
    },
  });
  const key = makeApiKey();
  const results = await sendQueries(host, changed, { hostname: HOSTNAME, key });
  const judged = judge(results, HOSTNAME);
  const lines = renderReport(results, judged, false);
  return { changed, key, posted, mostOpen, results, judged, lines };
}

/**
 * Makes the rpc's answer to a query: the slot.
 * @param {number} id  The query.
 * @returns {{status: number, body: string}}
 */
function slotAnswer(id) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result: 1000 + id });
  return { status: 200, body };
}

/**
 * Makes a request's error, as Node.js gives it.
 * @param {string} code  Its code.
 * @returns {Error}
 */
function requestError(code) {
  return Object.assign(new Error(`${code} from the stand-in`), { code });
}

test("every query answered: as many as the settings say, one after another, each with their time limit, and a green check mark", async () => {
  // Changed settings, so code that kept the shipped ones would show.
  const { changed, key, posted, mostOpen, judged, lines } =
    await check(slotAnswer);
  const count = changed.checkQueryCount;
  assert.equal(posted.length, count);
  assert.equal(mostOpen, 1);
  for (const [index, call] of posted.entries()) {
    assert.equal(call.url, `https://${HOSTNAME}/${key}`);
    assert.deepEqual(call.body, {
      jsonrpc: "2.0",
      id: index + 1,
      method: QUERY_METHOD,
    });
    assert.equal(call.timeoutMs, changed.requestTimeoutSeconds * 1000);
  }
  assert.equal(judged.passed, true);
  assert.ok(lines.includes(`│  1 │    200 │ slot 1001 │  5 ms │`), lines);
  const average = Math.round((5 * (count + 1)) / 2);
  assert.ok(
    lines.includes(
      `Answered ${count} of ${count}. Fastest 5 ms, average ${average} ms, slowest ${5 * count} ms.`,
    ),
    lines.join("\n"),
  );
  assert.equal(
    lines.at(-1),
    `✔ Your private rpc answered all ${count} queries with the key.`,
  );
  assert.equal(lines.join("\n").includes(key), false);
  assert.equal(
    checkingLine(changed, HOSTNAME, key),
    `Checking https://${HOSTNAME}/${maskSecret(key)} with ${count} ${QUERY_METHOD} queries, one right after another.`,
  );
});

test("nginx's refusals, an rpc it can't reach, an rpc error and answers that aren't json-rpc are each explained", async () => {
  // Each case: how the rpc answers, how many queries work first, and why.
  const cases = [
    [
      () => ({ status: 403, body: "" }),
      0,
      "nginx refused the key, with http 403: the key's hash isn't in nginx's list.",
    ],
    [
      (id) => (id > 2 ? { status: 429, body: "" } : slotAnswer(id)),
      2,
      "nginx turned queries away with http 429, for going over its rate limit.",
    ],
    [
      () => ({ status: 502, body: "" }),
      0,
      "nginx answered http 502, since it couldn't reach the validator's rpc.",
    ],
    [() => ({ status: 404, body: "" }), 0, "The keyed url answered http 404."],
    [
      () => ({
        status: 200,
        body: '{"jsonrpc":"2.0","error":{"code":-32005,"message":"Node is behind by 42 slots"}}',
      }),
      0,
      "The rpc answered with an error: Node is behind by 42 slots",
    ],
    [
      () => ({ status: 200, body: "<html>welcome</html>" }),
      0,
      "The answer wasn't json-rpc, so the validator's rpc didn't send it.",
    ],
  ];
  for (const [answer, working, reason] of cases) {
    const { changed, judged, lines } = await check(answer);
    const count = changed.checkQueryCount;
    assert.equal(judged.passed, false);
    assert.ok(
      lines
        .at(-1)
        .startsWith(
          `✘ ${count - working} of ${count} queries failed. ${reason}`,
        ),
      lines.at(-1),
    );
  }
});

test("a name that doesn't resolve, a refused connection, an untrusted certificate and no answer are each explained", async () => {
  const cases = [
    [
      "ENOTFOUND",
      `${HOSTNAME} doesn't resolve to an address. Check its A record`,
    ],
    [
      "ECONNREFUSED",
      `Nothing answered on port 443 at ${HOSTNAME} (ECONNREFUSED).`,
    ],
    [
      "CERT_HAS_EXPIRED",
      `${HOSTNAME}'s certificate isn't trusted (CERT_HAS_EXPIRED).`,
    ],
  ];
  for (const [code, reason] of cases) {
    const { changed, lines } = await check(() => {
      throw requestError(code);
    });
    const count = changed.checkQueryCount;
    assert.ok(lines.includes(`│  1 │      - │ ${code} │  5 ms │`), lines);
    assert.ok(
      lines
        .at(-1)
        .startsWith(`✘ ${count} of ${count} queries failed. ${reason}`),
      lines.at(-1),
    );
  }
  const silent = await check(() => {
    throw new Error(`No answer from https://${HOSTNAME} in 11000 ms.`);
  });
  assert.ok(
    silent.lines
      .at(-1)
      .endsWith(`failed. No answer from https://${HOSTNAME} in 11000 ms.`),
    silent.lines.at(-1),
  );
});

test("answers that aren't a hostname or an api key are refused", () => {
  const key = makeApiKey();
  assert.equal(inputProblem(HOSTNAME, key), "");
  // A url that apply or add-api-key printed, pasted at the hostname prompt.
  const pasted = inputProblem(`https://${HOSTNAME}/${key}`, key);
  assert.match(pasted, /^That isn't a hostname such as x1-rpc\.example\.com/);
  assert.equal(pasted.includes(key), false);
  assert.match(inputProblem(HOSTNAME, key.slice(1)), /^That isn't an api key/);
  assert.match(
    inputProblem(HOSTNAME, key.toUpperCase()),
    /^That isn't an api key/,
  );
});

test("the verdict's mark is green or red on a terminal", async () => {
  const worked = await check(slotAnswer);
  const passed = renderReport(worked.results, worked.judged, true).at(-1);
  assert.equal(passed, `\x1b[32m✔\x1b[0m ${worked.judged.verdict}`);
  const refused = await check(() => ({ status: 403, body: "" }));
  const failed = renderReport(refused.results, refused.judged, true).at(-1);
  assert.equal(failed, `\x1b[31m✘\x1b[0m ${refused.judged.verdict}`);
});

test("the real entry point prints its help with exit code 0, and the help's examples use each option it lists, but help, and no other", () => {
  const entry = fileURLToPath(
    new URL("../util/check-my-private-rpc/index.js", import.meta.url),
  );
  const help = spawnSync(process.execPath, [entry, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.startsWith("Checks once that a private rpc's keyed"));
  // Typed as the usage line says, from the project's folder, four levels
  // up, it runs on the Node.js the project needs.
  const command = `nvm exec ${oldestNode().major} node ${path.relative(path.resolve(entry, "../../../.."), entry)}`;
  assert.ok(help.stdout.includes(`\nUsage: ${command} [options]\n`));
  assert.ok(help.stdout.includes(`\n  ${command}\n`));
  assert.match(
    help.stdout,
    /\nExamples:\n {2}\S[^]*check-my-private-rpc\/index\.js[^]*\n\nExit codes:\n {2}\S/,
  );
  assert.deepEqual(optionGaps(help.stdout), []);
  const refused = spawnSync(process.execPath, [entry, "--bogus"], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unknown option '--bogus'/);
});
