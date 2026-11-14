/**
 * @file x1-validator-private-rpc/test/render-watchers.test.js
 * @description
 * Tests the two watchers that run `ensure`: x1console's git hook, which
 * can never fail a pull, and which is known as the tool's whatever paths
 * it names; and the crontab line, which runs every minute under flock.
 * Each names its paths quoted for the shell, and the cron line refuses a
 * path that cron would cut short.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isToolHook,
  renderCronLine,
  renderGitHook,
} from "../src/cli/render-watchers.js";

// Any paths will do; the spaces show each is quoted for the shell.
const PATHS = {
  nodeBin: "/opt/node js/bin/node",
  toolCli: "/opt/a tool/cli.js",
  lockPath: "/run/a tool/run.lock",
  logPath: "/var/log/a tool/run.log",
};

test("the git hook runs ensure from the hook, and never fails the pull", () => {
  assert.equal(
    renderGitHook(PATHS),
    "#!/bin/sh\n" +
      '# x1-validator-private-rpc: after "Update X1 Console" pulls new commits,\n' +
      "# put --private-rpc back into start_validator.sh. Never fails the pull.\n" +
      `'${PATHS.nodeBin}' '${PATHS.toolCli}' ensure --quiet --from-git-hook || true\n`,
  );
});

test("the tool's hook is known whatever paths it names, and no other is", () => {
  const quoted = { nodeBin: "/opt/o'brien/node", toolCli: "/srv/it's/cli.js" };
  assert.equal(isToolHook(renderGitHook(PATHS)), true);
  assert.equal(isToolHook(renderGitHook(quoted)), true);
  const hook = renderGitHook(PATHS);
  for (const other of [
    '#!/bin/sh\nexec git lfs post-merge "$@"\n',
    hook.replace("|| true", "|| exit 1"),
    `${hook}echo more\n`,
    hook.replace("# x1-validator-private-rpc", "# another tool"),
    "",
  ]) {
    assert.equal(isToolHook(other), false, other);
  }
});

test("the cron line runs ensure every minute, under flock, into its log", () => {
  assert.equal(
    renderCronLine(PATHS),
    `* * * * * flock -n '${PATHS.lockPath}' '${PATHS.nodeBin}' ` +
      `'${PATHS.toolCli}' ensure --quiet >> '${PATHS.logPath}' 2>&1`,
  );
});

test("the cron line refuses a path holding a % or a line break", () => {
  for (const bad of ["/home/a%b/node", "/home/a\nb/node"]) {
    assert.throws(() => renderCronLine({ ...PATHS, nodeBin: bad }), {
      message: /can't go in a crontab line/,
    });
  }
});
