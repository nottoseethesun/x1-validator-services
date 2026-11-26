/**
 * @file x1-validator-private-rpc/src/lib/node-version.js
 * @description
 * The check each of the feature's programs makes when it starts: that
 * the Node.js running it is the oldest one the project supports, or
 * newer. That oldest one is what `engines` in the root package.json
 * names, so the check needs no change at a move. The project's scripts
 * use the same reader, comparison and text, so the two can't drift. On
 * a validator, the default node is Node.js 20.0.0, which `x1console`
 * installed with nvm, the Node.js version manager, for its own scripts.
 * nvm holds the newer Node.js beside it. So a program started on an
 * older Node.js stops here, and says how to start it through nvm. Each
 * program reaches this check on 20.0.0: none loads a module 20.0.0 can't
 * parse before it. ora, the package that draws the upgrade check's
 * spinner, has such a module under it, so the upgrade check loads ora
 * only once the check has passed.
 */

import { readFileSync } from "node:fs";

/**
 * Reads the oldest Node.js the project supports, from `engines` in the
 * root package.json, which it finds from this file's own location.
 * @returns {{major: number, minor: number}}
 */
export function oldestNode() {
  const packageUrl = new URL("../../../package.json", import.meta.url);
  const range = JSON.parse(readFileSync(packageUrl, "utf8")).engines.node;
  const parts = range.startsWith(">=") ? range.slice(2).split(".") : [];
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(
      `package.json's engines.node is "${range}", but must be ">=" and ` +
        'a version, such as ">=24".',
    );
  }
  return { major: Number(parts[0]), minor: Number(parts[1] ?? 0) };
}

/**
 * The oldest Node.js as the docs and messages write it: the major alone,
 * such as "24", or major and minor when the minor isn't 0, such as
 * "24.15".
 * @returns {string}
 */
export function oldestNodeText() {
  const { major, minor } = oldestNode();
  return minor === 0 ? `${major}` : `${major}.${minor}`;
}

/**
 * Tells whether a Node.js version is the oldest one or newer.
 * @param {string} version  The version, as `process.versions.node` gives
 *   it, such as "24.9.0".
 * @returns {boolean}
 */
export function meetsOldestNode(version) {
  const { major, minor } = oldestNode();
  const [running, runningMinor] = version.split(".").map(Number);
  return running > major || (running === major && runningMinor >= minor);
}

/**
 * The paragraph a standalone tool's help gives on the Node.js it needs,
 * since its usage line starts it through nvm.
 * @returns {string}
 */
export function nodeHelpNote() {
  const { major } = oldestNode();
  return (
    `It needs Node.js ${oldestNodeText()} or newer, while a validator's default node is\n` +
    `Node.js 20.0.0, which x1console installed. So start it through nvm exec ${major},\n` +
    `which runs it on the Node.js ${major} that nvm, the Node.js version manager,\n` +
    "holds."
  );
}

/**
 * Tells why a program can't run on a Node.js version, or gives "" when
 * it can.
 * @param {string} version  The version, as `process.versions.node` gives
 *   it, such as "20.0.0".
 * @param {{name: string, command: string, note: string}} program  The
 *   program's name; the command that starts it from the project's folder,
 *   without nvm, such as "node x1-validator-private-rpc/src/cli.js
 *   COMMAND"; and the sentences more for the message, or "".
 * @returns {string}
 */
export function nodeVersionProblem(version, { name, command, note }) {
  if (meetsOldestNode(version)) {
    return "";
  }
  const { major } = oldestNode();
  return [
    `${name} needs Node.js ${oldestNodeText()} or newer, and this is Node.js ${version}.`,
    `If nvm, the Node.js version manager, has no Node.js ${major} yet, add it with: nvm install ${major}.`,
    `Then, from the project's folder, run it with: nvm exec ${major} ${command}.`,
    ...(note === "" ? [] : [note]),
  ].join(" ");
}
