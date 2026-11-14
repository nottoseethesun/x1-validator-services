/**
 * @file scripts/_lxd-apply-phase.js
 * @description
 * The second phase of the LXD system test, run on the container the
 * nginx upgrade phase left clean: x1-validator-private-rpc's apply,
 * ensure, unlock, url, turn-off-private-rpc, turn-on-private-rpc and
 * undo-apply, end to end, as the container's ordinary user, with sudo,
 * as on a validator. Never on a validator.
 *
 * The container plays a validator: a stand-in for Tachyon's rpc listens
 * on every interface, a git checkout holds the stand-in start script,
 * and the hostname points at the container in /etc/hosts. Pebble, Let's
 * Encrypt's test server, stands in for Let's Encrypt. Its certificate
 * authority goes into the system's store, which nginx's ACME module
 * trusts by default, and into NODE_EXTRA_CA_CERTS for the tool's own
 * checks. The commands' prompts are answered through a real terminal,
 * made by `script`, as a person would answer them.
 *
 * It checks the outcome after each step: apply's working request path,
 * its firewall rule, and logs that hold no key and that the validator's
 * account can't read. Then ensure: its failure while the rpc is public,
 * every one of its verdicts after the validator's restart, the flag put
 * back after `git stash`, and its silence about a public rpc while
 * private rpc is off. Then unlock after nginx comes back locked, the flag
 * back once private rpc is on, and a saved password that unlocks nginx
 * after a restart and that a later apply sees. After undo-apply, the
 * container must be as apply found it.
 *
 * Last, a firewall rule for port 443 with a comment, added before apply
 * while ufw is off, as in a fresh container. An apply stopped after its
 * firewall stage must record the rule as found, and undo-apply must
 * leave it as the operator made it. The paths it checks come from the
 * app: the settings the tool loads there, and the tool's own paths.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HTTPS_RULE } from "../x1-validator-private-rpc/src/cli/apply-install.js";
import {
  featurePaths,
  homePath,
} from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import { API_KEY_HEX_DIGITS } from "../x1-validator-private-rpc/src/lib/api-key.js";
import { NGINX_UNIT } from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { overrideFilePath } from "../x1-validator-private-rpc/src/lib/settings.js";
import {
  asRoot,
  asRootCaptured,
  asUser,
  asUserArgs,
  asUserCaptured,
  existingPaths,
  firewallAllows,
  GUEST_HOME,
  GUEST_PROJECT,
  leftovers,
  mustPass,
  pathsTheToolMightCreate,
  readScript,
  ufwHolds,
} from "./_lxd.js";
import { projectRoot, runCaptured } from "./_tools.js";

const HOSTNAME = "x1-rpc.example.com";
const PEBBLE = "https://github.com/letsencrypt/pebble";
const PEBBLE_VERSION = "v2.10.3";
const NODE_CA = "/opt/pebble/node-ca.pem";
const PASSWORD = "a long password for the system test";
const STANDIN = `${GUEST_PROJECT}/x1-validator-private-rpc/test/helpers/rpc-standin.js`;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const FLAG_LINE = "--rpc-port 8899 --private-rpc \\";

/** Installs Pebble, trusts its certificate authorities, and starts it. */
const PEBBLE_SETUP = `set -e
systemctl stop pebble 2>/dev/null || true
systemctl reset-failed pebble 2>/dev/null || true
mkdir -p /opt/pebble/certs/localhost && cd /opt/pebble
curl -fsSL -o pebble.tar.gz ${PEBBLE}/releases/download/${PEBBLE_VERSION}/pebble-linux-amd64.tar.gz
tar -xzf pebble.tar.gz
for f in pebble.minica.pem localhost/cert.pem localhost/key.pem; do
  curl -fsSL -o certs/$f https://raw.githubusercontent.com/letsencrypt/pebble/${PEBBLE_VERSION}/test/certs/$f
done
cp certs/pebble.minica.pem /usr/local/share/ca-certificates/pebble-minica.crt
update-ca-certificates >/dev/null
cat > pebble.json <<'EOF'
{ "pebble": {
  "listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
  "certificate": "/opt/pebble/certs/localhost/cert.pem", "privateKey": "/opt/pebble/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "retryAfter": {"authz": 3, "order": 5}, "keyAlgorithm": "ecdsa",
  "profiles": {"default": {"description": "default", "validityPeriod": 7776000}} } }
EOF
binary=/opt/pebble/pebble-linux-amd64/linux/amd64/pebble
chmod +x "$binary"
systemd-run --unit=pebble --setenv=PEBBLE_VA_NOSLEEP=1 --setenv=PEBBLE_WFE_NONCEREJECT=0 "$binary" -config /opt/pebble/pebble.json
for i in $(seq 1 30); do curl -fsk https://127.0.0.1:15000/roots/0 > roots.pem && break; sleep 1; done
curl -fsk https://127.0.0.1:15000/intermediates/0 >> roots.pem
cat certs/pebble.minica.pem roots.pem > ${NODE_CA}
`;

/**
 * Finds a path the project holds, where it sits in the container.
 * @param {string} localPath  The path on this machine.
 * @returns {string}
 */
function inGuestProject(localPath) {
  const relative = path.relative(projectRoot(), localPath);
  return path.posix.join(GUEST_PROJECT, relative);
}

/**
 * Finds the tool's command where it sits in the container.
 * @returns {string}
 */
function guestCli() {
  const { toolCli } = featurePaths();
  return inGuestProject(toolCli);
}

/**
 * Writes the script that makes the stand-in x1console checkout, as the
 * container's user, where the settings say x1console and its start
 * script are.
 * @param {object} settings  The settings the tool loads in the container.
 * @returns {string}
 */
function x1consoleSetup(settings) {
  const folder = homePath(settings.x1consoleDir, GUEST_HOME);
  const script = settings.startScriptFile;
  return `set -e
mkdir -p ${folder}
cp ${GUEST_PROJECT}/x1-validator-private-rpc/test/fixtures/start_validator.sh ${folder}/${script}
cd ${folder}
git init -q
git add ${script}
git diff --cached --quiet || git -c user.name=test -c user.email=test@example.invalid commit -qm "the x1console stand-in"
`;
}

/**
 * Runs a command in the container as its user, in a real terminal, and
 * answers its prompts as each one appears.
 * @param {string} name  The container.
 * @param {string} command  The command, as the shell reads it.
 * @param {[string, string][]} answers  Each prompt's text, and its answer.
 * @returns {Promise<{code: number, output: string}>}
 */
function withAnswers(name, command, answers) {
  return new Promise((resolve) => {
    const child = spawn(
      "lxc",
      asUserArgs(name, ["script", "-qfec", command, "/dev/null"], {
        NODE_EXTRA_CA_CERTS: NODE_CA,
      }),
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    let unread = "";
    let next = 0;
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      unread += chunk;
      let [prompt, reply] = answers.at(next) ?? [];
      while (
        prompt !== undefined &&
        prompt !== null &&
        unread.includes(prompt)
      ) {
        unread = unread.slice(unread.indexOf(prompt) + prompt.length);
        child.stdin.write(reply);
        next += 1;
        [prompt, reply] = answers.at(next) ?? [];
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/**
 * Runs one of the tool's commands as the container's user, with
 * NODE_EXTRA_CA_CERTS set, streaming its output.
 * @param {string} name  The container.
 * @param {string[]} args  The command and its options.
 * @returns {number} Its exit code.
 */
function tool(name, args) {
  const cli = guestCli();
  return asUser(name, ["node", cli, ...args], { NODE_EXTRA_CA_CERTS: NODE_CA });
}

/**
 * Runs ensure in the container, printing every check, and reads its
 * verdicts.
 * @param {string} name  The container.
 * @returns {boolean} Whether ensure exited 0 and printed at least one
 *   check, every one of them ok: an unknown verdict, which leaves the
 *   exit code at 0, counts against it.
 */
function everyCheckOk(name) {
  const cli = guestCli();
  const env = { NODE_EXTRA_CA_CERTS: NODE_CA };
  const run = runCaptured(
    "lxc",
    asUserArgs(name, ["node", cli, "ensure"], env),
  );
  process.stdout.write(run.stdout);
  const verdicts = run.stdout
    .split("\n")
    .map((line) => /^\[ensure\] (\w+): /.exec(line)?.[1])
    .filter((status) => status !== undefined && status !== null);
  return (
    run.status === 0 &&
    verdicts.length > 0 &&
    verdicts.every((status) => status === "ok")
  );
}

/**
 * Starts the rpc stand-in, public or private, in place of any running.
 * @param {string} name  The container.
 * @param {string} address  The container's address.
 * @param {boolean} isPrivate  Whether it plays a validator started with
 *   --private-rpc.
 */
function startRpc(name, address, isPrivate) {
  asRootCaptured(name, ["systemctl", "stop", "rpc-standin"]);
  const started = asRoot(name, [
    "systemd-run",
    "--unit=rpc-standin",
    "--collect",
    "--uid=ubuntu",
    "--gid=ubuntu",
    "/opt/node/bin/node",
    STANDIN,
    isPrivate ? "127.0.0.1" : "0.0.0.0",
    address,
    ...(isPrivate ? ["--private-rpc"] : []),
  ]);
  mustPass(started, "Starting the rpc stand-in");
  const listening = asRoot(name, [
    "sh",
    "-c",
    "for i in $(seq 1 20); do ss -ltnH 'sport = :8899' | grep -q . && exit 0; sleep 0.5; done; exit 1",
  ]);
  mustPass(listening, "Waiting for the rpc stand-in");
}

/**
 * Checks one fact about the container, collecting a failure.
 * @param {string[]} failures  Collects what's wrong.
 * @param {string} what  The fact, in words.
 * @param {boolean} holds  Whether it holds.
 */
function expect(failures, what, holds) {
  console.log(`${holds ? "ok  " : "FAIL"}  ${what}`);
  if (!holds) {
    failures.push(what);
  }
}

/**
 * Sets the container up as a validator for the tool: Pebble, the
 * hostname, the operator's settings, the x1console checkout where those
 * settings put it, and the rpc stand-in.
 * @param {string} name  The container.
 * @param {() => object} settingsOf  Reads the settings the tool loads in
 *   the container.
 * @returns {{address: string, settings: object}} The container's
 *   address, and the settings the tool loads there.
 */
function setUpValidator(name, settingsOf) {
  const address = asRootCaptured(name, ["hostname", "-I"])
    .stdout.trim()
    .split(/\s+/)[0];
  const gitReady = asRoot(name, [
    "sh",
    "-c",
    "command -v git >/dev/null || apt -o Apt::Cmd::Disable-Script-Warning=true install -y git",
  ]);
  mustPass(gitReady, "Installing git");
  const pebble = asRoot(name, ["sh", "-c", PEBBLE_SETUP]);
  mustPass(pebble, "Setting up Pebble");
  const named = asRoot(name, [
    "sh",
    "-c",
    `grep -q " ${HOSTNAME}$" /etc/hosts || echo "${address} ${HOSTNAME}" >> /etc/hosts`,
  ]);
  mustPass(named, "Naming the container");
  const override = JSON.stringify({
    hostname: HOSTNAME,
    acmeDirectoryUrl: "https://127.0.0.1:14000/dir",
  });
  const localOverride = overrideFilePath();
  const overridePath = inGuestProject(localOverride);
  const written = asUser(name, [
    "sh",
    "-c",
    `printf '%s\\n' '${override}' > ${overridePath}`,
  ]);
  mustPass(written, "Writing the operator's settings");
  const settings = settingsOf();
  const setup = x1consoleSetup(settings);
  const checkout = asUser(name, ["sh", "-c", setup]);
  mustPass(checkout, "Making the x1console checkout");
  startRpc(name, address, false);
  return { address, settings };
}

/**
 * Sends many keyed requests at once, as root in the container.
 * @param {string} name  The container.
 * @param {string} key  The api key.
 * @param {number} count  How many.
 * @returns {{forwarded: number, limited: number}} How many got 200, and
 *   how many 429.
 */
function burstOfRequests(name, key, count) {
  const one = `curl -s -o /dev/null -w "%{http_code}\\n" --cacert ${NODE_CA} https://${HOSTNAME}/${key}/health`;
  const codes = asRootCaptured(name, [
    "sh",
    "-c",
    `for i in $(seq 1 ${count}); do ${one} & done; wait`,
  ]).stdout.split("\n");
  return {
    forwarded: codes.filter((code) => code === "200").length,
    limited: codes.filter((code) => code === "429").length,
  };
}

/**
 * Sends two mistyped requests, one with a doubled slash and one with the
 * key a character short, then checks that nginx's logs hold no key and
 * that no other account can read them.
 * @param {string} name  The container.
 * @param {string} key  The api key.
 * @param {object} settings  The settings the tool loads there.
 * @param {string[]} failures  Collects what's wrong.
 */
function checkLogs(name, key, settings, failures) {
  for (const urlPath of [`//${key}/health`, `/${key.slice(0, -1)}/health`]) {
    const asked = asRootCaptured(name, [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "--cacert",
      NODE_CA,
      `https://${HOSTNAME}${urlPath}`,
    ]);
    mustPass(asked.status, "Asking nginx with a mistyped url");
  }
  const logDir = settings.nginxLogDir;
  const shortKey = key.slice(0, -1);
  const leaked = asRootCaptured(name, ["grep", "-rl", shortKey, logDir]);
  expect(
    failures,
    "nginx's logs hold no key, even from a mistyped url",
    leaked.stdout.trim() === "",
  );
  const listed = asRootCaptured(name, ["find", logDir, "-type", "f"]);
  const logs = listed.stdout.split("\n").filter((line) => line !== "");
  // As the validator's account, with all its groups, adm among them.
  const readable = logs.filter(
    (log) => asUserCaptured(name, ["cat", log]).status === 0,
  );
  expect(
    failures,
    "nginx writes its logs, and the validator's account can't read them",
    logs.length > 0 && readable.length === 0,
  );
}

/**
 * Lists the paths in the user's home and in the tool's own folder that a
 * run of apply might create in the container, from the app's own paths,
 * moved to where the project and the home folder sit there.
 * @param {object} settings  The settings the tool loads in the container.
 * @returns {string[]}
 */
function guestPathsOf(settings) {
  const local = featurePaths();
  const x1consoleDir = homePath(settings.x1consoleDir, GUEST_HOME);
  return [
    homePath(settings.vaultPath, GUEST_HOME),
    path.posix.join(x1consoleDir, ".git", "hooks", "post-merge"),
    ...[
      local.tmpDir,
      local.logsDir,
      local.statePath,
      local.whatApplyChangedPath,
      local.alertStatePath,
    ].map(inGuestProject),
  ];
}

/**
 * Reads whether apply's record in the container says apply found the
 * firewall rule already there, and left it.
 * @param {string} name  The container.
 * @returns {boolean}
 */
function recordFoundRule(name) {
  const recordPath = inGuestProject(featurePaths().whatApplyChangedPath);
  const read = asUserCaptured(name, ["cat", recordPath]);
  if (read.status !== 0) {
    return false;
  }
  const record = new Map(Object.entries(JSON.parse(read.stdout)));
  const entry = record.get(`firewallRule:${HTTPS_RULE}`);
  return entry?.applyChangedThisFromItsPreviousValue === false;
}

/**
 * Checks the container once undo-apply has run: nothing apply made is
 * left, the firewall rule and the cron line are gone, nginx.service is
 * no longer masked, and x1console's checkout is as committed, with no
 * backup beside the start script.
 * @param {string} name  The container.
 * @param {object} watched  The paths apply might make, and those of
 *   them that were there before it ran.
 * @param {object} settings  The settings the tool loads there.
 * @param {string[]} failures  Collects what's wrong.
 */
function checkUndone(name, watched, settings, failures) {
  const left = leftovers(name, watched.paths, watched.before);
  for (const item of left) {
    console.error(`Left behind: ${item}`);
  }
  expect(failures, "undo-apply leaves nothing apply made", left.length === 0);
  expect(
    failures,
    "undo-apply removed the firewall rule",
    !firewallAllows(name, HTTPS_RULE),
  );
  const crontab = asUserCaptured(name, ["crontab", "-l"]).stdout;
  expect(
    failures,
    "undo-apply removed the cron line",
    !crontab.includes(" ensure "),
  );
  const enabled = asRootCaptured(name, [
    "systemctl",
    "is-enabled",
    NGINX_UNIT,
  ]).stdout.trim();
  expect(failures, `undo-apply unmasked ${NGINX_UNIT}`, enabled !== "masked");
  const x1consoleDir = homePath(settings.x1consoleDir, GUEST_HOME);
  const status = asUserCaptured(name, [
    "git",
    "-C",
    x1consoleDir,
    "status",
    "--porcelain",
  ]).stdout;
  expect(
    failures,
    "undo-apply gave back x1console's checkout as committed, with no backup",
    status === "",
  );
}

/**
 * Checks the case apply's record exists for: a firewall rule for port
 * 443 the operator added before apply, with a comment, while ufw is off,
 * as in a fresh container, whose `ufw status` then lists no rule.
 * `ufw allow 443/tcp` would overwrite such a rule. apply stops after its
 * firewall stage, and its record must say it found the rule. Then
 * undo-apply runs, and the rule must still be there as the operator made
 * it, with nothing apply made left behind. The rule goes after.
 * @param {string} name  The container.
 * @param {object} watched  The paths apply might make, and those of
 *   them that were there before it ran.
 * @param {string[]} failures  Collects what's wrong.
 * @returns {Promise<void>}
 */
async function checkKeepsOperatorRule(name, watched, failures) {
  const comment = "added by the operator";
  const operatorRule = `ufw allow ${HTTPS_RULE} comment '${comment}'`;
  const added = asRoot(name, ["ufw", "allow", HTTPS_RULE, "comment", comment]);
  mustPass(added, "Adding the operator's firewall rule");
  const cli = guestCli();
  const stopped = await withAnswers(name, `node ${cli} apply`, [
    ["Stage 2 of 8", "y\n"],
    ["Stage 3 of 8", "y\n"],
    ["Stage 4 of 8", "n\n"],
  ]);
  const foundRule = recordFoundRule(name);
  const undone = tool(name, ["undo-apply"]);
  const left = leftovers(name, watched.paths, watched.before);
  for (const item of left) {
    console.error(`Left behind: ${item}`);
  }
  expect(
    failures,
    "undo-apply leaves a firewall rule that was there before apply, comment and all, while ufw is off",
    stopped.code === 1 &&
      foundRule &&
      undone === 0 &&
      left.length === 0 &&
      ufwHolds(name, operatorRule),
  );
  const removed = asRoot(name, ["ufw", "delete", "allow", HTTPS_RULE]);
  mustPass(removed, "Removing the operator's firewall rule");
}

/**
 * Runs the phase.
 * @param {string} name  The container.
 * @param {() => object} settingsOf  Reads the settings the tool loads in
 *   the container.
 * @returns {Promise<boolean>} Whether every check passed.
 */
export async function runApplyPhase(name, settingsOf) {
  const failures = [];
  const { address, settings } = setUpValidator(name, settingsOf);
  const cli = guestCli();
  const guestPaths = guestPathsOf(settings);
  const paths = pathsTheToolMightCreate(settings, guestPaths);
  const before = existingPaths(name, paths);
  const watched = { paths, before };
  const applied = await withAnswers(name, `node ${cli} apply --yes`, [
    ["A new x1-validator-services password: ", `${PASSWORD}\n`],
    ["The same password again: ", `${PASSWORD}\n`],
    ["Save the password", "n\n"],
  ]);
  expect(failures, "apply finishes every stage", applied.code === 0);
  if (applied.code !== 0) {
    return false;
  }
  expect(
    failures,
    "apply added the firewall rule",
    firewallAllows(name, HTTPS_RULE),
  );
  const url = await withAnswers(name, `node ${cli} url`, [
    ["password: ", `${PASSWORD}\n`],
  ]);
  const urlStart = `https://${HOSTNAME}/`;
  const found = url.output.indexOf(urlStart);
  const keyStart = found + urlStart.length;
  const key =
    found === -1
      ? ""
      : url.output.slice(keyStart, keyStart + API_KEY_HEX_DIGITS);
  const health = asRootCaptured(name, [
    "curl",
    "-s",
    "--cacert",
    NODE_CA,
    `https://${HOSTNAME}/${key}/health`,
  ]).stdout;
  expect(
    failures,
    "a client with the url reaches the rpc through nginx",
    health === "ok",
  );
  const refused = asRootCaptured(name, [
    "curl",
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--cacert",
    NODE_CA,
    `https://${HOSTNAME}/`,
  ]).stdout;
  expect(failures, "a request without the key gets 403", refused === "403");
  const limit = settings.rateLimitRequestsPerSecond;
  const burst = burstOfRequests(name, key, 3 * limit);
  expect(
    failures,
    `nginx forwards a burst of ${limit} keyed requests, and answers more with 429 (${burst.forwarded} and ${burst.limited})`,
    burst.forwarded >= limit && burst.limited > 0,
  );
  checkLogs(name, key, settings, failures);
  const beforeRestart = tool(name, ["ensure"]);
  expect(
    failures,
    "ensure finds the rpc public before the validator's restart",
    beforeRestart === 1,
  );
  startRpc(name, address, true);
  expect(
    failures,
    "ensure finds every check ok after the restart",
    everyCheckOk(name),
  );
  const x1consoleDir = homePath(settings.x1consoleDir, GUEST_HOME);
  const stashed = asUser(name, ["git", "-C", x1consoleDir, "stash", "-q"]);
  mustPass(stashed, "Stashing the start script, as an x1console update does");
  tool(name, ["ensure", "--quiet", "--from-git-hook"]);
  const restored = readScript(name, settings);
  expect(
    failures,
    "ensure put --private-rpc back after the stash",
    restored.includes(FLAG_LINE),
  );
  const restarted = asRoot(name, ["systemctl", "restart", NGINX_UNIT]);
  mustPass(restarted, "Restarting nginx");
  const locked = tool(name, ["ensure", "--quiet"]);
  expect(
    failures,
    "nginx comes back locked without a saved password",
    locked === 1,
  );
  const unlocked = await withAnswers(name, `node ${cli} unlock`, [
    ["password: ", `${PASSWORD}\n`],
  ]);
  const afterUnlock = tool(name, ["ensure", "--quiet"]);
  expect(
    failures,
    "unlock opens nginx again",
    unlocked.code === 0 && afterUnlock === 0,
  );
  const turnedOff = tool(name, ["turn-off-private-rpc", "--yes"]);
  const offScript = readScript(name, settings);
  expect(
    failures,
    "turn-off-private-rpc takes --private-rpc out",
    turnedOff === 0 && !offScript.includes(FLAG_LINE),
  );
  startRpc(name, address, false);
  const whileOff = tool(name, ["ensure"]);
  const leftOut = readScript(name, settings);
  expect(
    failures,
    "while private rpc is off, ensure accepts a public rpc and leaves the flag out",
    whileOff === 0 && !leftOut.includes(FLAG_LINE),
  );
  const turnedOn = tool(name, ["turn-on-private-rpc"]);
  const onScript = readScript(name, settings);
  expect(
    failures,
    "turn-on-private-rpc puts --private-rpc back",
    turnedOn === 0 && onScript.includes(FLAG_LINE),
  );
  startRpc(name, address, true);
  expect(
    failures,
    "ensure finds every check ok once the validator takes the flag again",
    everyCheckOk(name),
  );
  const saving = await withAnswers(name, `node ${cli} apply --yes`, [
    ["password: ", `${PASSWORD}\n`],
    ["Save the password", "y\n"],
  ]);
  const restartedSaved = asRoot(name, ["systemctl", "restart", NGINX_UNIT]);
  mustPass(restartedSaved, "Restarting nginx with the password saved");
  const unlockedItself = tool(name, ["ensure", "--quiet"]);
  expect(
    failures,
    "with the password saved, nginx unlocks itself after a restart",
    saving.code === 0 && unlockedItself === 0,
  );
  const reapplied = await withAnswers(name, `node ${cli} apply --yes`, [
    ["password: ", `${PASSWORD}\n`],
    ["Save the password", "y\n"],
  ]);
  expect(
    failures,
    "a later apply sees the saved password, and doesn't ask again",
    reapplied.code === 0 && !reapplied.output.includes("Save the password"),
  );
  const undone = await withAnswers(name, `node ${cli} undo-apply`, [
    ["Delete the saved password?", "y\n"],
    ["Delete the api key?", "y\n"],
  ]);
  expect(failures, "undo-apply finishes", undone.code === 0);
  checkUndone(name, watched, settings, failures);
  await checkKeepsOperatorRule(name, watched, failures);
  return failures.length === 0;
}
