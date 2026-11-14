/**
 * @file x1-validator-private-rpc/test/helpers/fake-x1-validator.js
 * @description
 * A fake host that plays a stock x1console validator for apply, ensure
 * and undo-apply: Ubuntu 24.04 with systemd 255 and no TPM2 chip,
 * x1console's start script and git checkout where the settings put them,
 * a running validator whose rpc listens on every interface, ufw, an
 * empty crontab, and the hostname's A record pointing at the validator.
 * Its commands change a small state, as the real ones would change the
 * machine:
 *
 * - apt installs nginx and its modules, which count as installed until
 *   nginx itself is purged
 * - userdel removes the account nginx's package made
 * - systemctl masks and starts nginx
 * - ufw adds and deletes rules, skips one it holds, and overwrites one
 *   for the same port with another action, log setting or comment
 * - crontab keeps its table
 *
 * ufw is on, unless a scenario turns it off. Its status then lists no
 * rules, though it still holds them. A folder root makes with mode 0700
 * hides what it holds from the validator's account, as on a real system.
 * nginx, once started with a hand-off key, answers the gate page, the
 * keyed path and a path without the key, with a certificate for the
 * hostname. A scenario changes the starting state.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featurePaths, homePath } from "../../src/cli/feature-paths.js";
import { CHAT_ID_FILE, TOKEN_FILE } from "../../src/cli/telegram.js";
import { GATE_PAGE_PATH } from "../../src/lib/gate-page.js";
import { NGINX_UNIT, PINNED_FINGERPRINTS } from "../../src/lib/nginx-org.js";
import { shippedSettings } from "./config-copies.js";
import { createFakeHost } from "./fake-host.js";

export const HOME = "/home/validator";
export const HOSTNAME = "x1-rpc.example.com";
export const PUBLIC_IP = "203.0.113.10";
export const IDENTITY = "ValidatorIdentity1111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1000;

const COLONS = PINNED_FINGERPRINTS.map(
  (fpr) => `pub:-:4096:1:X:1:::-:::scSC::::::23::0:\nfpr:::::::::${fpr}:`,
).join("\n");

/** systemd-creds' answer on the owner's validator, which has no chip. */
export const NO_TPM2 =
  "partial\n-firmware\n-driver\n+system\n+subsystem\n-libraries\n";

/**
 * Reads the fixture start script.
 * @returns {string}
 */
function startScript() {
  return fs.readFileSync(
    fileURLToPath(new URL("../fixtures/start_validator.sh", import.meta.url)),
    "utf8",
  );
}

/**
 * Makes the machine's starting state.
 * @param {object} [changes]  How this scenario differs.
 * @returns {object}
 */
function startingState(changes = {}) {
  return {
    nginxInstalled: false,
    nginxUser: false,
    masked: false,
    enabled: false,
    active: false,
    unlocked: false,
    ufwActive: true,
    ufwRules: ["22/tcp", "8000:10000/tcp"],
    crontab: null,
    rpcAddress: "0.0.0.0",
    flagRunning: false,
    certificateDays: 89,
    tpm2: NO_TPM2,
    rootOnlyFolders: [],
    ...changes,
  };
}

/**
 * Answers `systemctl is-enabled` for nginx.service, as systemd does.
 * @param {object} state  The machine's state.
 * @returns {object}
 */
function unitFileAnswer(state) {
  if (state.masked) {
    return { status: 1, stdout: "masked\n" };
  }
  if (state.enabled) {
    return { stdout: "enabled\n" };
  }
  if (state.nginxInstalled) {
    return { status: 1, stdout: "disabled\n" };
  }
  return {
    status: 1,
    stderr: `Failed to get unit file state for ${NGINX_UNIT}: No such file or directory\n`,
  };
}

/**
 * Writes one of the fake's ufw rules as `ufw show added` prints it, after
 * `ufw `. A bare port, such as `443/tcp`, is an allow rule; any other rule
 * is written out, such as `limit 443/tcp`.
 * @param {string} rule  The rule.
 * @returns {string}
 */
function shownRule(rule) {
  return rule.includes(" ") ? rule : `allow ${rule}`;
}

/**
 * Reads the action and the port of one of the fake's ufw rules.
 * @param {string} rule  The rule.
 * @returns {{action: string, port: string}}
 */
function partsOfRule(rule) {
  const [action, ...words] = shownRule(rule).split(" ");
  const logged = words[0] === "log" || words[0] === "log-all";
  return { action, port: logged ? words[1] : words[0] };
}

/**
 * Answers ufw, as the real one does: its status lists the rules only
 * while it's on, and `show added` lists them either way. Allowing a port
 * skips a rule it holds already, and overwrites one for the same port
 * with another action, log setting or comment.
 * @param {object} call  The command.
 * @param {object} state  The machine's state.
 * @returns {object}
 */
function ufwAnswer(call, state) {
  const [verb] = call.args;
  if (verb === "status") {
    const rules = state.ufwRules.map((rule) => {
      const { action, port } = partsOfRule(rule);
      return `${port} ${action.toUpperCase()} Anywhere`;
    });
    return state.ufwActive
      ? { stdout: `Status: active\n\nTo Action From\n${rules.join("\n")}\n` }
      : { stdout: "Status: inactive\n" };
  }
  if (verb === "show") {
    const added = state.ufwRules.map((rule) => `ufw ${shownRule(rule)}`);
    return {
      stdout: `Added user rules (see 'ufw status' for running firewall):\n${added.join("\n")}\n`,
    };
  }
  const port = call.args.at(-1);
  if (verb === "delete") {
    state.ufwRules = state.ufwRules.filter((rule) => {
      const parts = partsOfRule(rule);
      return parts.port !== port || parts.action !== "allow";
    });
    return { stdout: "Rule deleted\n" };
  }
  const same = state.ufwRules.findIndex(
    (rule) => partsOfRule(rule).port === port,
  );
  if (same === -1) {
    state.ufwRules = [...state.ufwRules, port];
    return { stdout: "Rule added\n" };
  }
  if (state.ufwRules[same] === port) {
    return { stdout: "Skipping adding existing rule\n" };
  }
  state.ufwRules = state.ufwRules.map((rule, index) =>
    index === same ? port : rule,
  );
  return { stdout: "Rule updated\n" };
}

/**
 * Answers the commands that read the system.
 * @param {string} line  The command line.
 * @param {object} state  The machine's state.
 * @returns {object|undefined}
 */
function systemAnswer(line, state) {
  const answers = new Map([
    ["systemctl --version", { stdout: "systemd 255 (255.4-1ubuntu8)\n" }],
    [`systemctl is-enabled ${NGINX_UNIT}`, unitFileAnswer(state)],
    ["systemd-creds has-tpm2", { status: 1, stdout: state.tpm2 }],
    [
      "getent passwd nginx",
      state.nginxUser
        ? { stdout: "nginx:x:101:101::/nonexistent" }
        : { status: 2 },
    ],
    [
      `systemctl is-active ${NGINX_UNIT}`,
      {
        status: state.active ? 0 : 3,
        stdout: state.active ? "active\n" : "inactive\n",
      },
    ],
    [
      "crontab -l",
      state.crontab === null
        ? { status: 1, stderr: "no crontab for validator" }
        : { stdout: state.crontab },
    ],
    [
      "ss -ltnH sport = :443",
      {
        stdout: state.active ? `LISTEN 0 511 ${PUBLIC_IP}:443 0.0.0.0:*\n` : "",
      },
    ],
    [
      "ss -ltnH ( sport = :443 or sport = :80 )",
      {
        stdout: state.active ? `LISTEN 0 511 ${PUBLIC_IP}:443 0.0.0.0:*\n` : "",
      },
    ],
    [
      "ss -ltnH ( sport = :8899 or sport = :8900 )",
      {
        stdout: `LISTEN 0 1024 ${state.rpcAddress}:8899 0.0.0.0:*\nLISTEN 0 1024 ${state.rpcAddress}:8900 0.0.0.0:*\n`,
      },
    ],
    [
      "ss -ltnpH sport = :8899",
      {
        stdout: `LISTEN 0 1024 ${state.rpcAddress}:8899 0.0.0.0:* users:(("tachyon-validat",pid=4242,fd=50))\n`,
      },
    ],
  ]);
  return answers.get(line);
}

/**
 * Answers the commands that install and remove packages and users, root's
 * folders, and root's look at whether a path exists.
 * @param {object} call  The command.
 * @param {string} line  Its command line.
 * @param {object} state  The machine's state.
 * @param {Map<string, string>} files  The fake's files.
 * @returns {object|undefined}
 */
function packageAnswer(call, line, state, files) {
  const apt = "apt -o Apt::Cmd::Disable-Script-Warning=true";
  if (line.includes(`${apt} install`)) {
    Object.assign(state, { nginxInstalled: true, nginxUser: true });
    return {};
  }
  if (line.includes(`${apt} purge`)) {
    /*-
     * nginx and its modules count as installed until nginx itself goes.
     * nginx.org's package leaves its user behind, as the real one does.
     */
    if (call.args.includes("nginx")) {
      Object.assign(state, { nginxInstalled: false });
    }
    return {};
  }
  if (line === "userdel nginx") {
    Object.assign(state, { nginxUser: false });
    return {};
  }
  if (call.command === "test" && call.args[0] === "-e") {
    return { status: files.has(call.args[1]) ? 0 : 1 };
  }
  if (call.command === "install" && call.args[0] === "-d") {
    const folder = call.args.at(-1);
    const mode = call.args.at(call.args.indexOf("-m") + 1);
    if (mode === "0700") {
      state.rootOnlyFolders.push(folder);
    }
    files.set(folder, "");
    return {};
  }
  return undefined;
}

/**
 * Answers the commands that change the machine, changing its state.
 * @param {object} call  The command.
 * @param {string} line  Its command line.
 * @param {object} state  The machine's state.
 * @param {Map<string, string>} files  The fake's files.
 * @returns {object|undefined}
 */
function changeAnswer(call, line, state, files) {
  const systemctlVerbs = new Map([
    ["mask", () => Object.assign(state, { masked: true })],
    ["unmask", () => Object.assign(state, { masked: false })],
    ["enable", () => Object.assign(state, { enabled: true })],
    [
      "restart",
      () => {
        // The start wrapper reads the hand-off file and deletes it.
        const handedOver = files.has(state.handOffPath ?? "");
        files.delete(state.handOffPath ?? "");
        Object.assign(state, { active: true, unlocked: handedOver });
      },
    ],
    ["daemon-reload", () => state],
  ]);
  if (call.kind === "sudo" && call.command === "systemctl") {
    if (call.args[0] === "disable") {
      Object.assign(state, { enabled: false, active: false, unlocked: false });
    }
    systemctlVerbs.get(call.args[0])?.();
    return {};
  }
  if (call.kind === "sudo" && call.command === "ufw") {
    return ufwAnswer(call, state);
  }
  if (line === "crontab -") {
    state.crontab = call.input;
    return {};
  }
  if (call.kind === "sudo" && call.command === "sh") {
    files.set(call.args.at(-1), call.input);
    return {};
  }
  if (call.kind === "sudo" && call.command === "systemd-creds") {
    files.set(call.args.at(-1), "encrypted credential");
    return {};
  }
  return undefined;
}

/**
 * Answers the gpg calls that check nginx.org's key.
 * @param {object} call  The command.
 * @returns {object|undefined}
 */
function gpgAnswer(call) {
  if (call.command === "gpg" && call.args.includes("--show-keys")) {
    return { stdout: COLONS };
  }
  if (call.command === "gpg" && call.args.includes("--export")) {
    return { stdout: Buffer.from("pinned keyring") };
  }
  return undefined;
}

/**
 * Answers nginx's https paths the way the real nginx would.
 * @param {object} state  The machine's state.
 * @param {object} target  The request.
 * @param {(ms: number) => number} clock  The fake's clock.
 * @returns {Promise<object>}
 */
async function nginxAnswer(state, target, clock) {
  if (!state.active) {
    throw new Error(`connect ECONNREFUSED ${target.address}:443`);
  }
  const certificate = {
    validTo: clock() + state.certificateDays * DAY_MS,
    altNames: `DNS:${target.hostname}`,
    issuer: "Let's Encrypt",
  };
  const key = state.key ?? "";
  if (target.path === GATE_PAGE_PATH) {
    return {
      status: 200,
      body: state.unlocked ? "unlocked\n" : "locked\n",
      certificate,
    };
  }
  if (state.unlocked && key !== "" && target.path === `/${key}/health`) {
    return { status: 200, body: "ok", certificate };
  }
  return { status: 403, body: "", certificate };
}

/**
 * Builds a fake x1console validator.
 * @param {object} [scenario]  How this scenario differs.
 * @param {object} [scenario.state]  Changes to the starting state.
 * @param {Map<string, string>} [scenario.files]  More files.
 * @param {(call: object, state: object) => object|undefined}
 *   [scenario.respond]  Answers some commands first.
 * @param {boolean} [scenario.telegram]  Whether x1console's Telegram
 *   files exist.
 * @param {object} [scenario.settings]  The settings that say where
 *   x1console's checkout and start script are: the shipped ones, unless
 *   the test changes them.
 * @returns {{host: object, state: object, scriptPath: string}} The fake,
 *   its state, and where its start script is.
 */
export function fakeX1Validator(scenario = {}) {
  const state = startingState(scenario.state);
  const paths = featurePaths();
  const settings = scenario.settings ?? shippedSettings();
  const x1consoleDir = homePath(settings.x1consoleDir, HOME);
  // Not through the app's own function, so a test sees the app ignore it.
  const scriptPath = path.join(x1consoleDir, settings.startScriptFile);
  const files = new Map([
    [
      "/etc/os-release",
      'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n',
    ],
    ["/etc/resolv.conf", "nameserver 127.0.0.53\noptions edns0\n"],
    [scriptPath, startScript()],
    [paths.njsModuleSource, "export default {};\n"],
    ["/usr/bin/node", ""],
    ...["/usr/bin/apt", "/usr/sbin/ufw", "/usr/bin/sudo", "/usr/bin/gpg"].map(
      (tool) => [tool, ""],
    ),
    [paths.toolCli, ""],
    [
      "/proc/4242/cmdline",
      [
        "tachyon-validator",
        "--rpc-port",
        "8899",
        ...(state.flagRunning ? ["--private-rpc"] : []),
      ].join("\0"),
    ],
    ...(scenario.telegram
      ? [
          [
            path.join(x1consoleDir, TOKEN_FILE),
            "123456:telegram-token-for-tests\n",
          ],
          [path.join(x1consoleDir, CHAT_ID_FILE), "-1001\n"],
        ]
      : []),
    ...(scenario.files ?? []),
  ]);
  const posts = [];
  let host = null;
  const respond = (call) => {
    const line = [call.command, ...call.args].join(" ");
    if (call.command === "sh" && call.kind === "sudo") {
      Object.assign(state, { key: call.input, handOffPath: call.args.at(-1) });
    }
    return (
      scenario.respond?.(call, state) ??
      systemAnswer(line, state) ??
      packageAnswer(call, line, state, files) ??
      changeAnswer(call, line, state, files) ??
      gpgAnswer(call) ??
      (call.command === "dpkg-query"
        ? state.nginxInstalled
          ? { stdout: "install ok installed 1.30.6-1~noble" }
          : { status: 1 }
        : undefined)
    );
  };
  host = createFakeHost({
    respond,
    files,
    folders: [
      "/etc/apt/keyrings",
      "/etc/apt/sources.list.d",
      "/etc/apt/preferences.d",
      "/etc/systemd/system",
      "/etc/logrotate.d",
      "/etc/nginx",
      "/usr/local",
      "/run",
      "/var/log",
      path.join(x1consoleDir, ".git", "hooks"),
      // Without the slash it ends in, as the folders made under it name it.
      path.resolve(paths.featureDir),
    ],
    httpsGet: async (url) => ({
      status: 200,
      body: url.includes("nginx.org") ? "-----BEGIN PGP-----" : "{}",
    }),
    postJson: async (url, body) => {
      posts.push({ url, body });
      if (url.startsWith("http://127.0.0.1:8899")) {
        const results = new Map([
          ["getIdentity", { identity: IDENTITY }],
          [
            "getClusterNodes",
            [
              { pubkey: "OtherNode", gossip: "198.51.100.7:8001" },
              { pubkey: IDENTITY, gossip: `${PUBLIC_IP}:8001` },
            ],
          ],
        ]);
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: results.get(body.method),
          }),
        };
      }
      return { status: 200, body: '{"ok":true}' };
    },
    tlsGet: (target) => nginxAnswer(state, target, () => host.now()),
    dns: { [HOSTNAME]: [PUBLIC_IP] },
    addresses: ["127.0.0.1", PUBLIC_IP],
  });
  host.posts = posts;
  const exists = host.exists;
  // The validator's account can't see inside a folder root keeps to itself.
  host.exists = (filePath) =>
    !state.rootOnlyFolders.some((folder) =>
      filePath.startsWith(`${folder}/`),
    ) && exists(filePath);
  return { host, state, scriptPath };
}
