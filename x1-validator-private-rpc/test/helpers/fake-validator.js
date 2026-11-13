/**
 * @file x1-validator-private-rpc/test/helpers/fake-validator.js
 * @description
 * A fake host that plays a stock Ubuntu 24.04 validator for the nginx
 * upgrade check's tests. It answers the check's commands from a small
 * state that its apt installs change: the first install puts nginx.org's
 * previous nginx in place and creates nginx's user, and a later one
 * upgrades it, handing over to a new main process. Each scenario changes
 * the starting state, or answers some commands itself.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NGINX_APT_PIN_PATH,
  NGINX_APT_SOURCE_PATH,
  NGINX_KEYRING_PATH,
  PINNED_FINGERPRINTS,
} from "../../src/lib/nginx-org.js";
import { createFakeHost } from "./fake-host.js";

const NJS_SOURCE = fileURLToPath(
  new URL("../../src/njs/x1-validator-private-rpc.js", import.meta.url),
);

const NGINX_ORG =
  "https://nginx.org/packages/ubuntu noble/nginx amd64 Packages";

const POLICY = [
  ["nginx", "1.30.6-1~noble", "1.30.5-1~noble"],
  ["nginx-module-njs", "1.30.6+1.0.2-1~noble", "1.30.5+1.0.1-1~noble"],
  ["nginx-module-acme", "1.30.6+0.4.2-1~noble", "1.30.5+0.4.1-1~noble"],
]
  .flatMap(([name, ...versions]) => [
    `${name}:`,
    "  Installed: (none)",
    `  Candidate: ${versions[0]}`,
    "  Version table:",
    ...versions.flatMap((version) => [
      `     ${version} 900`,
      `        900 ${NGINX_ORG}`,
    ]),
  ])
  .join("\n");

const COLONS = PINNED_FINGERPRINTS.map(
  (fpr) => `pub:-:4096:1:X:1:::-:::scSC::::::23::0:\nfpr:::::::::${fpr}:`,
).join("\n");

/**
 * Answers the commands about nginx's user, which nginx's package creates.
 * @param {string} line  The command line.
 * @param {object} state  The fake validator's state.
 * @returns {object|undefined}
 */
function userAnswer(line, state) {
  if (line === "getent passwd nginx") {
    return state.nginxUser
      ? { stdout: "nginx:x:101:101::/nonexistent" }
      : { status: 2 };
  }
  if (line === "userdel nginx") {
    state.nginxUser = false;
    return {};
  }
  return undefined;
}

/**
 * Plays an apt install: the first one installs nginx and creates its
 * user; a later one upgrades nginx, handing over to a new main process.
 * @param {object} call  The command.
 * @param {object} state  The fake validator's state.
 * @param {Map<string, string>} files  The fake's files.
 */
function playInstall(call, state, files) {
  if (state.installed !== null) {
    if (!state.keepOldMain) {
      files.delete(`/proc/${state.mainPid}`);
    }
    state.mainPid = state.upgradedPid;
    state.active = state.activeAfter;
  }
  state.installed = call.args.find((arg) => arg.startsWith("nginx=")).slice(6);
  state.nginxUser = true;
}

/**
 * Answers the commands every scenario shares, from the scenario's state.
 * @param {object} call  The command.
 * @param {object} state  The fake validator's state, changed by installs.
 * @param {Map<string, string>} files  The fake's files.
 * @returns {object|undefined}
 */
function commonAnswer(call, state, files) {
  const line = [call.command, ...call.args].join(" ");
  if (line === "systemctl --version") {
    return { stdout: "systemd 255 (255.4-1ubuntu8)\n" };
  }
  if (call.command === "dpkg-query") {
    return state.installed === null
      ? { status: 1 }
      : { stdout: `install ok installed ${state.installed}` };
  }
  if (call.command === "gpg" && call.args.includes("--show-keys")) {
    return { stdout: COLONS };
  }
  if (call.command === "apt" && call.args.includes("policy")) {
    return { stdout: POLICY };
  }
  if (call.args.includes("apt") && call.args.includes("install")) {
    playInstall(call, state, files);
    return undefined;
  }
  const userAnswered = userAnswer(line, state);
  if (userAnswered !== undefined) {
    return userAnswered;
  }
  if (line.startsWith("systemctl show")) {
    return {
      stdout:
        `ActiveState=${state.active}\nInvocationID=${state.invocation}\n` +
        `MainPID=${state.mainPid}\n`,
    };
  }
  if (call.kind === "sudo" && call.command === "readlink") {
    return { stdout: "/usr/sbin/nginx\n" };
  }
  return undefined;
}

/**
 * Builds a fake validator for one scenario. Its apt folders exist, as on
 * a stock system, and nothing else the check writes does.
 * @param {object} [overrides]  How this scenario differs.
 * @param {(call: object, state: object) => object|undefined}
 *   [overrides.respond]  Answers some commands before the common ones.
 * @param {object} [overrides.state]  Changes to the starting state.
 * @param {(url: string) => Promise<object>} [overrides.httpGet]  Answers
 *   the gate page.
 * @returns {{host: object, state: object}}
 */
export function fakeValidator(overrides = {}) {
  const state = {
    installed: null,
    mainPid: "100",
    upgradedPid: "200",
    invocation: "invocation-1",
    active: "active",
    activeAfter: "active",
    keepOldMain: false,
    nginxUser: false,
    ...overrides.state,
  };
  const files = new Map([
    ["/etc/os-release", "ID=ubuntu\nVERSION_CODENAME=noble\n"],
    [NJS_SOURCE, "export default {};\n"],
    ["/proc/100", ""],
  ]);
  const respond = (call) =>
    overrides.respond?.(call, state) ?? commonAnswer(call, state, files);
  const host = createFakeHost({
    respond,
    files,
    folders: [
      NGINX_KEYRING_PATH,
      NGINX_APT_SOURCE_PATH,
      NGINX_APT_PIN_PATH,
    ].map((filePath) => path.dirname(filePath)),
    httpsGet: async () => ({ status: 200, body: "-----BEGIN PGP-----" }),
    httpGet: overrides.httpGet,
  });
  return { host, state };
}
