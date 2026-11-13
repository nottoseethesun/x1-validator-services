/**
 * @file x1-validator-private-rpc/test/render-host-files.test.js
 * @description
 * Tests the text of the system files the tool installs: nginx.org's apt
 * source and pin, the start wrapper and the systemd drop-in.
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
  renderStartWrapper,
} from "../src/lib/render-host-files.js";

const WRAPPER_VALUES = {
  validatorUser: "validator",
  nodeBin: "/home/validator/.nvm/versions/node/v20.0.0/bin/node",
  toolCli:
    "/home/validator/x1-validator-services/x1-validator-private-rpc/src/cli.js",
  nginxConfigPath: "/etc/nginx/x1-validator-private-rpc/nginx.conf",
  keyHandOffPath: "/run/x1-validator-private-rpc/api-key",
};

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
  const wrapper = renderStartWrapper(WRAPPER_VALUES);
  assert.ok(wrapper.startsWith("#!/bin/sh\n"));
  assert.match(wrapper, /^VALIDATOR_USER='validator'$/m);
  assert.match(
    wrapper,
    /^KEY_HANDOFF='\/run\/x1-validator-private-rpc\/api-key'$/m,
  );
  assert.match(wrapper, /\*\[!0-9a-f\]\*\) key="" ;;/);
  assert.match(wrapper, /if \[ "\$\{#key\}" -ne 64 \]; then/);
  assert.ok(wrapper.endsWith('exec /usr/sbin/nginx -c "$NGINX_CONF"\n'));
});

test("the start wrapper keeps a quote inside a value as part of the value", () => {
  const wrapper = renderStartWrapper({
    ...WRAPPER_VALUES,
    validatorUser: "a'b",
  });
  assert.match(wrapper, /^VALIDATOR_USER='a'\\''b'$/m);
});

test("the drop-in starts nginx through the wrapper", () => {
  const dropIn = renderDropIn({
    startWrapperPath: "/usr/local/libexec/x1-validator-private-rpc/nginx-start",
    passwordCredentialPath: null,
  });
  assert.match(dropIn, /^ExecStart=$/m);
  assert.match(
    dropIn,
    /^ExecStart=\/usr\/local\/libexec\/x1-validator-private-rpc\/nginx-start$/m,
  );
  assert.doesNotMatch(dropIn, /LoadCredentialEncrypted/);
});

test("with a saved password, the drop-in loads it as a credential", () => {
  const dropIn = renderDropIn({
    startWrapperPath: "/usr/local/libexec/x1-validator-private-rpc/nginx-start",
    passwordCredentialPath:
      "/etc/credstore.encrypted/x1-validator-services-password",
  });
  assert.match(
    dropIn,
    /^LoadCredentialEncrypted=x1-validator-services-password:\/etc\/credstore\.encrypted\/x1-validator-services-password$/m,
  );
});
