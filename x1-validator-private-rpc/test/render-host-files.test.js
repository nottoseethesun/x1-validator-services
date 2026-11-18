/**
 * @file x1-validator-private-rpc/test/render-host-files.test.js
 * @description
 * Tests the text of the system files the tool installs: nginx.org's apt
 * source and pin, the systemd drop-in with nginx's own read-only /dev,
 * which makes nginx's log folder when it's missing, and the shell
 * quoting the watchers use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NGINX_KEYRING_PATH,
  NGINX_LOG_DIR,
  NGINX_LOG_DIR_MODE,
  NGINX_REPOSITORY_URL,
} from "../src/lib/nginx-org.js";
import {
  renderAptPin,
  renderAptSource,
  renderDropIn,
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

test("the drop-in makes nginx's log folder when it's missing, as nginx.org's package makes it, starts nginx with the configured configuration and its own read-only /dev, and loads no credential", () => {
  const { changed } = shippedAndChangedSettings();
  const dropIn = renderDropIn(changed);
  const lines = dropIn.split("\n");
  // nginx can't start without its log folder. One that's there stays.
  assert.ok(
    lines.includes(
      `ExecStartPre=/bin/sh -c 'test -d ${NGINX_LOG_DIR} || ` +
        `install -d -m ${NGINX_LOG_DIR_MODE} ${NGINX_LOG_DIR}'`,
    ),
    dropIn,
  );
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
