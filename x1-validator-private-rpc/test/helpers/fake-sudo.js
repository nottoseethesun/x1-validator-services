#!/usr/bin/env node
/**
 * @file x1-validator-private-rpc/test/helpers/fake-sudo.js
 * @description
 * A stand-in for sudo in the host's tests. It runs the command after
 * `--` as the current user, with the same input and output, and exits
 * with the command's code. It never gains privileges, so a test can
 * exercise the host's root-file functions inside a temporary folder.
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const start = args[0] === "--" ? 1 : 0;
const result = spawnSync(args[start], args.slice(start + 1), {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
