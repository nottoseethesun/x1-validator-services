/**
 * @file x1-validator-private-rpc/test/node-version.test.js
 * @description
 * Tests how the feature's programs make sure they run on the Node.js the
 * project needs, the one `engines` in package.json names:
 *
 * - the check each program makes when it starts, which lets that version
 *   and newer through, and refuses an older one, saying how to start the
 *   program through nvm
 * - the launcher the README links into ~/.local/bin, run through such a
 *   link, which runs the tool on the newest release nvm holds of that
 *   major, and says how to add the major when nvm holds none of it
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestTempFolder } from "../../scripts/_test-temp-folders.js";
import { nodeVersionProblem, oldestNode } from "../src/lib/node-version.js";

const LAUNCHER = fileURLToPath(
  new URL("../bin/x1-validator-private-rpc", import.meta.url),
);
// The launcher finds the tool from its own path, with links resolved.
const CLI = fs.realpathSync(
  fileURLToPath(new URL("../src/cli.js", import.meta.url)),
);

const PROGRAM = {
  name: "a-program",
  command: "node a/program.js COMMAND",
  note: "",
};

test("the check lets the oldest Node.js and newer through, and refuses an older one", () => {
  const { major, minor } = oldestNode();
  for (const version of [
    `${major}.${minor}.0`,
    `${major}.${minor + 1}.0`,
    `${major + 2}.0.0`,
  ]) {
    assert.equal(nodeVersionProblem(version, PROGRAM), "", version);
  }
  const older = `${major - 1}.99.0`;
  assert.equal(
    nodeVersionProblem(older, PROGRAM),
    `a-program needs Node.js ${major} or newer, and this is Node.js ${older}. ` +
      `If nvm, the Node.js version manager, has no Node.js ${major} yet, add it with: nvm install ${major}. ` +
      `Then, from the project's folder, run it with: nvm exec ${major} ` +
      "node a/program.js COMMAND.",
  );
  const withNote = nodeVersionProblem("20.0.0", {
    ...PROGRAM,
    note: "A sentence more.",
  });
  assert.ok(withNote.endsWith("COMMAND. A sentence more."), withNote);
});

/**
 * Links the launcher into a folder of its own, as the README links it
 * into ~/.local/bin, since the operator runs it through that link.
 * @returns {string} The link.
 */
function linkedLauncher() {
  const link = path.join(makeTestTempFolder("launcher-link"), "x1-vpr");
  fs.symlinkSync(LAUNCHER, link);
  return link;
}

/**
 * Makes a stand-in for nvm's folder, holding the given Node.js releases.
 * Each release's node prints the arguments it was started with.
 * @param {string[]} versions  The releases, such as "v24.9.0".
 * @returns {string} The folder.
 */
function fakeNvm(versions) {
  const nvmDir = makeTestTempFolder("launcher");
  for (const version of versions) {
    const bin = path.join(nvmDir, "versions", "node", version, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\necho "$0" "$@"\n', {
      mode: 0o755,
    });
  }
  return nvmDir;
}

test("the launcher runs the tool on the newest release nvm holds of the major engines names", () => {
  const { major } = oldestNode();
  const newest = `v${major}.10.0`;
  const nvmDir = fakeNvm([
    `v${major}.9.0`,
    newest,
    `v${major}.2.1`,
    `v${major + 2}.0.0`,
  ]);
  const result = spawnSync(linkedLauncher(), ["url", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NVM_DIR: nvmDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const node = path.join(nvmDir, "versions", "node", newest, "bin", "node");
  assert.equal(result.stdout, `${node} ${CLI} url --help\n`);
});

test("the launcher says how to add the major when nvm holds none of it", () => {
  const { major } = oldestNode();
  const nvmDir = fakeNvm([`v${major - 2}.0.0`, `v${major + 2}.0.0`]);
  const result = spawnSync(linkedLauncher(), ["url"], {
    encoding: "utf8",
    env: { ...process.env, NVM_DIR: nvmDir },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(`nvm install ${major}\n`), result.stderr);
});
