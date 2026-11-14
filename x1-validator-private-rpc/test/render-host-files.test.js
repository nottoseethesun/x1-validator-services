/**
 * @file x1-validator-private-rpc/test/render-host-files.test.js
 * @description
 * Tests the text of the system files the tool installs: nginx.org's apt
 * source and pin, the start wrapper, the systemd drop-in and the
 * logrotate rule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { featurePaths } from "../src/cli/feature-paths.js";
import { API_KEY_HEX_DIGITS } from "../src/lib/api-key.js";
import {
  NGINX_KEYRING_PATH,
  NGINX_REPOSITORY_URL,
} from "../src/lib/nginx-org.js";
import {
  PASSWORD_CREDENTIAL,
  renderAptPin,
  renderAptSource,
  renderDropIn,
  renderLogrotateRule,
  renderStartWrapper,
} from "../src/lib/render-host-files.js";
import { shippedAndChangedSettings } from "./helpers/config-copies.js";

/**
 * Makes the start wrapper's values, with each setting changed from its
 * shipped value, so a test sees the wrapper use the values it's given.
 * @returns {object}
 */
function wrapperValues() {
  const { changed } = shippedAndChangedSettings();
  return {
    validatorUser: "validator",
    nodeBin: "/home/validator/.nvm/versions/node/v20.0.0/bin/node",
    toolCli: featurePaths().toolCli,
    nginxConfigPath: changed.nginxConfigPath,
    keyHandOffPath: changed.keyHandOffPath,
  };
}

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

test("the start wrapper quotes its values and starts nginx with its config", () => {
  const values = wrapperValues();
  const wrapper = renderStartWrapper(values);
  const lines = wrapper.split("\n");
  assert.ok(wrapper.startsWith("#!/bin/sh\n"));
  assert.match(wrapper, /^VALIDATOR_USER='validator'$/m);
  assert.ok(lines.includes(`KEY_HANDOFF='${values.keyHandOffPath}'`), wrapper);
  assert.ok(lines.includes(`NGINX_CONF='${values.nginxConfigPath}'`), wrapper);
  assert.match(wrapper, /\*\[!0-9a-f\]\*\) key="" ;;/);
  assert.ok(
    wrapper.includes(`if [ "\${#key}" -ne ${API_KEY_HEX_DIGITS} ]; then`),
  );
  assert.ok(wrapper.endsWith('exec /usr/sbin/nginx -c "$NGINX_CONF"\n'));
});

test("the start wrapper keeps a quote inside a value as part of the value", () => {
  const wrapper = renderStartWrapper({
    ...wrapperValues(),
    validatorUser: "a'b",
  });
  assert.match(wrapper, /^VALIDATOR_USER='a'\\''b'$/m);
});

test("the drop-in starts nginx through the wrapper", () => {
  const { changed } = shippedAndChangedSettings();
  const dropIn = renderDropIn({
    startWrapperPath: changed.startWrapperPath,
    passwordCredentialPath: null,
  });
  const lines = dropIn.split("\n");
  assert.ok(lines.includes("ExecStart="), dropIn);
  assert.ok(lines.includes(`ExecStart=${changed.startWrapperPath}`), dropIn);
  assert.doesNotMatch(dropIn, /LoadCredentialEncrypted/);
});

test("with a saved password, the drop-in loads it as a credential", () => {
  const { changed } = shippedAndChangedSettings();
  const dropIn = renderDropIn(changed);
  const credential = `${PASSWORD_CREDENTIAL}:${changed.passwordCredentialPath}`;
  assert.ok(
    dropIn.split("\n").includes(`LoadCredentialEncrypted=${credential}`),
    dropIn,
  );
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
