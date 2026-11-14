/**
 * @file x1-validator-private-rpc/test/examples.test.js
 * @description
 * Keeps the examples true. Each example of a file the tool renders must
 * equal, byte for byte, what the tool writes for the placeholder values,
 * with the shipped settings and no acmeEmail. The cron and hook
 * examples, which use $HOME paths, must run the real command. The
 * examples' README must name every example.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { featurePaths } from "../src/cli/feature-paths.js";
import { renderNginxConfig } from "../src/cli/render-nginx.js";
import {
  renderAptPin,
  renderAptSource,
  renderDropIn,
  renderLogrotateRule,
  renderStartWrapper,
} from "../src/lib/render-host-files.js";
import { listFilesUnder } from "../../scripts/_tools.js";
import { copyShippedConfig } from "./helpers/config-copies.js";
import { loadSettings } from "../src/lib/settings.js";

const EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));

/**
 * Reads one example.
 * @param {string} name  Its path inside examples/.
 * @returns {string}
 */
function example(name) {
  return fs.readFileSync(path.join(EXAMPLES, name), "utf8");
}

/**
 * Finds where the examples show one of the tool's own files: in the
 * checkout the README has the operator clone, under a home folder.
 * @param {string} home  The home folder, as the example writes it.
 * @param {string} filePath  The file, as featurePaths gives it here.
 * @returns {string}
 */
function shownPath(home, filePath) {
  const { featureDir } = featurePaths();
  const inProject = path.relative(path.dirname(featureDir), filePath);
  return path.posix.join(home, "x1-validator-services", inProject);
}

/**
 * Renders each example the tool writes, for the placeholder values.
 * @returns {Object<string, string>} The text, by example path.
 */
function rendered() {
  const settings = loadSettings(copyShippedConfig().configDir);
  const home = "/home/VALIDATOR_USER";
  const paths = featurePaths();
  const toolCli = shownPath(home, paths.toolCli);
  return {
    "nginx/nginx.conf.example": renderNginxConfig({
      hostname: "x1-rpc.example.com",
      publicIp: "203.0.113.10",
      rpcPort: 8899,
      resolver: "127.0.0.53",
      staging: false,
      settings,
    }),
    "systemd/x1-validator-private-rpc.conf.example": renderDropIn(settings),
    "systemd/nginx-start.example": renderStartWrapper({
      ...settings,
      validatorUser: "VALIDATOR_USER",
      nodeBin: `${home}/.nvm/versions/node/v20.0.0/bin/node`,
      toolCli,
    }),
    "logrotate/x1-validator-private-rpc.example": renderLogrotateRule(settings),
    "apt/nginx.sources.example": renderAptSource("noble"),
    "apt/99nginx.example": renderAptPin(),
  };
}

test("each rendered example is what the tool writes for the placeholders", () => {
  for (const [name, text] of Object.entries(rendered())) {
    assert.equal(example(name), text, name);
  }
});

test("the cron and hook examples run the real command", () => {
  const paths = featurePaths();
  const lock = shownPath("$HOME", paths.lockPath);
  const cli = shownPath("$HOME", paths.toolCli);
  const log = shownPath("$HOME", paths.ensureLogPath);
  const cron = example("cron/x1-validator-private-rpc-ensure.cron.example");
  const line = cron.trimEnd().split("\n").at(-1);
  assert.ok(line.startsWith(`* * * * * flock -n ${lock} $HOME/`), line);
  assert.ok(
    line.endsWith(`/bin/node ${cli} ensure --quiet >> ${log} 2>&1`),
    line,
  );
  const hook = example("git-hooks/post-merge.example");
  assert.ok(hook.startsWith("#!/bin/sh\n"));
  assert.ok(
    hook.endsWith(
      `/bin/node" "${cli}" ensure --quiet --from-git-hook || true\n`,
    ),
    hook,
  );
});

test("the examples' README names every example", () => {
  const readme = example("README.md");
  const names = listFilesUnder(EXAMPLES, ".").filter(
    (name) => name !== "README.md",
  );
  assert.equal(names.length, 8);
  for (const name of names) {
    assert.ok(readme.includes(`\`${name}\``), name);
  }
});
