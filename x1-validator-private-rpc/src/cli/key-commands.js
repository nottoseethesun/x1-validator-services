/**
 * @file x1-validator-private-rpc/src/cli/key-commands.js
 * @description
 * The `url` command. It prints the rpc's two url forms, with KEY in
 * place of an api key, and how many keys nginx's list holds. It can't
 * show a key: the tool keeps only the keys' hashes, and showed each key
 * once, when apply or add-api-key made it. So it asks no password.
 */

import { apiKeysCount, apiKeyUrls, readMapCount } from "./hashed-api-keys.js";
import { readAppliedState } from "./state.js";

/**
 * Runs url.
 * @param {object} run  The run: host, settings, paths, and out, which
 *   prints a line on stdout.
 * @returns {Promise<number>} The exit code.
 * @throws {Error} When apply hasn't set nginx up, since there's no url
 *   to print until then.
 */
export async function runUrl(run) {
  const { host, settings, paths, out } = run;
  const { setup } = readAppliedState(host, paths.statePath);
  const count = readMapCount(host, settings.hashedApiKeysMapPath);
  for (const url of apiKeyUrls(setup.hostname, "KEY")) {
    out(url);
  }
  out(
    `With an api key in place of KEY. nginx's list holds ${apiKeysCount(count)}.`,
  );
  return 0;
}
