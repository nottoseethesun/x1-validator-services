/**
 * @file x1-validator-private-rpc/test/render-host-files.test.js
 * @description
 * Tests the text of the system files the tool installs: nginx.org's apt
 * source and pin, the systemd drop-in with nginx's own read-only /dev,
 * the logrotate rule, and the shell quoting the watchers use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NGINX_KEYRING_PATH,
  NGINX_REPOSITORY_URL,
} from "../src/lib/nginx-org.js";
import {
  renderAptPin,
  renderAptSource,
  renderDropIn,
  renderLogrotateRule,
  shellQuote,
} from "../src/lib/render-host-files.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

test("the apt source is a deb822 entry naming the release and the pinned keyring", () => {
  assert.deepEqual(renderAptSource("noble").split("\n").slice(1), [
    "Types: deb",
    `URIs: ${NGINX_REPOSITORY_URL}`,
    "Suites: noble",
    "Components: nginx",
    `Signed-By: ${NGINX_KEYRING_PATH}`,
    "",
  ]);
});

test("the apt pin prefers nginx.org's packages", () => {
  const pin = renderAptPin();
  assert.match(pin, /^Pin: origin nginx\.org$/m);
  assert.match(pin, /^Pin-Priority: 900$/m);
});

test("a quoted value stays one word for the shell, a quote inside it included", () => {
  assert.equal(shellQuote("/a path/b"), "'/a path/b'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("the drop-in starts nginx with the configured configuration and its own read-only /dev, and loads no credential", () => {
  const { changed } = shippedAndChangedSettings();
  const dropIn = renderDropIn(changed);
  const lines = dropIn.split("\n");
  assert.ok(lines.includes("ExecStart="), dropIn);
  assert.ok(
    lines.includes(`ExecStart=/usr/sbin/nginx -c ${changed.nginxConfigPath}`),
    dropIn,
  );
  // Without it, reopening the logs hands /dev/null to the nginx account.
  assert.ok(
    lines.indexOf("PrivateDevices=yes") > lines.indexOf("[Service]"),
    dropIn,
  );
  assert.doesNotMatch(dropIn, /Credential/);
});

test("the logrotate rule keeps the configured days of the configured logs", () => {
  const rule = renderLogrotateRule({
    nginxLogDir: "/srv/logs/rpc",
    logRetentionDays: 30,
    logrotateRulePath: "/etc/logrotate.d/rpc",
  });
  assert.match(
    rule,
    /^# keep 30 days of them\. Copy to \/etc\/logrotate\.d\/rpc$/m,
  );
  assert.match(rule, /^\/srv\/logs\/rpc\/\*\.log \{$/m);
  assert.match(rule, /^ {4}rotate 30$/m);
  assert.match(rule, /kill -USR1 "\$\(cat \/run\/nginx\.pid\)"/);
});
