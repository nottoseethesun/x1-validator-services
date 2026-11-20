/**
 * @file scripts/_lxd-apply-phase.js
 * @description
 * The second phase of the LXD system test, run on the container the
 * nginx upgrade phase left clean: x1-validator-private-rpc's apply,
 * ensure, url, add-api-key, remove-api-key, the key count check,
 * turn-off-private-rpc, turn-on-private-rpc and undo-apply, end to end,
 * as the container's ordinary user, with sudo, as on a validator. Never
 * on a validator.
 *
 * The container plays a validator: a stand-in for Tachyon's rpc listens
 * on every interface, a git checkout holds the stand-in start script,
 * and the hostname points at the container in /etc/hosts. Pebble, Let's
 * Encrypt's test server, stands in for Let's Encrypt. Its certificate
 * authority goes into the system's store, which nginx's ACME module
 * trusts by default, and into NODE_EXTRA_CA_CERTS for the tool's own
 * checks. The commands' prompts are answered through a real terminal,
 * made by `script`, as a person would answer them, the disclaimer's
 * dialog among them.
 *
 * It checks the outcome after each step: the first key apply shows, its
 * working request path, the saved password, the firewall rule, logs that
 * hold no key and keep the mode nginx.org's package gives them, and
 * nginx's own read-only /dev, with the key still working once nginx
 * reopens its logs. Then ensure: its failure while the rpc is public, every one of
 * its verdicts after the validator's restart, the flag put back by the
 * tool's git hook when `git stash` and a `git pull` that brings a commit
 * play an Update X1 Console, and its silence about a public rpc while
 * private rpc is off. Then every key working after a restart of nginx,
 * two keys added with an email and one of them removed, the flag back
 * once private rpc is on, and a later apply that asks nothing. undo-apply
 * answered no keeps the keys and the saved password, and the next apply
 * hands nginx the same keys. The last undo-apply, answered yes, must
 * leave nginx installed, stopped and masked, and say how to purge it.
 * Once the test purges nginx, as the operator may, a second undo-apply
 * must leave the container as apply found it.
 *
 * Last, a firewall rule for port 443 with a comment, added before apply
 * while ufw is off, as in a fresh container. An apply stopped after its
 * firewall stage must record the rule as found, and undo-apply, again
 * with a purge of nginx and a second run, must leave it as the operator
 * made it. The paths it checks come from the
 * app: the settings the tool loads there, and the tool's own paths.
 */

import fs from "node:fs";
import path from "node:path";
import { HTTPS_RULE } from "../x1-validator-private-rpc/src/cli/apply-install.js";
import {
  NEW_PASSWORD_PROMPT,
  SAME_PASSWORD_PROMPT,
  SAVE_PASSWORD_QUESTION,
} from "../x1-validator-private-rpc/src/cli/apply-key.js";
import {
  featurePaths,
  gitHookPathOf,
  hashedApiKeysPathOf,
  homePath,
} from "../x1-validator-private-rpc/src/cli/feature-paths.js";
import { KEYS_AND_PASSWORD_QUESTION } from "../x1-validator-private-rpc/src/cli/undo-apply.js";
import { makeApiKey } from "../x1-validator-private-rpc/src/lib/api-key.js";
import { NGINX_UNIT } from "../x1-validator-private-rpc/src/lib/nginx-org.js";
import { overrideFilePath } from "../x1-validator-private-rpc/src/lib/settings.js";
import {
  answersWith,
  asksForPassword,
  checkAddAndRemove,
  checkKeepsKeys,
  checkSavedPassword,
  keysIn,
} from "./_lxd-api-key-checks.js";
import {
  checkLogFolderComesBack,
  checkLogs,
  checkNginxStays,
  checkOwnDev,
  purgeThenUndo,
} from "./_lxd-nginx-checks.js";
import {
  AFFIRM_DISCLAIMER,
  answerInTerminal,
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
/** One of Autopilot's jobs, from the project's root, which must stay. */
const CRONTAB_FIXTURE = "x1-validator-private-rpc/test/fixtures/crontab";
const FLAG_LINE = "--rpc-port 8899 --private-rpc \\";
/** The stand-in for x1console's repository on GitHub. */
const X1CONSOLE_ORIGIN = `${GUEST_HOME}/x1console-origin`;
const COMMIT =
  "git -c user.name=test -c user.email=test@example.invalid commit -q";

/** Installs Pebble, trusts its certificate authorities, and starts it. */
const PEBBLE_SETUP = `set -e
systemctl stop pebble 2>/dev/null || true
systemctl reset-failed pebble 2>/dev/null || true
mkdir -p /opt/pebble/certs/localhost && cd /opt/pebble
curl -fsSL --retry 3 -o pebble.tar.gz ${PEBBLE}/releases/download/${PEBBLE_VERSION}/pebble-linux-amd64.tar.gz
tar -xzf pebble.tar.gz
for f in pebble.minica.pem localhost/cert.pem localhost/key.pem; do
  curl -fsSL --retry 3 -o certs/$f https://raw.githubusercontent.com/letsencrypt/pebble/${PEBBLE_VERSION}/test/certs/$f
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
 * container's user: a stand-in for x1console's repository, cloned where
 * the settings say x1console and its start script are, so the checkout
 * pulls from it as x1console's pulls from GitHub. The script is committed
 * executable, as x1console's is, so the last check's `git status` sees a
 * command that drops the mode after the test's `git stash`, which puts
 * the committed mode back. apply's own edit comes before that, so its
 * unit test covers it.
 * The user's crontab gets one of Autopilot's jobs, which the last check
 * looks for. In the container it only fails, since the stand-in has no
 * `autopilot.sh`.
 * @param {object} settings  The settings the tool loads in the container.
 * @returns {string}
 */
function x1consoleSetup(settings) {
  const folder = homePath(settings.x1consoleDir, GUEST_HOME);
  const script = settings.startScriptFile;
  return `set -e
mkdir -p ${X1CONSOLE_ORIGIN}
cp ${GUEST_PROJECT}/x1-validator-private-rpc/test/fixtures/start_validator.sh ${X1CONSOLE_ORIGIN}/${script}
chmod 755 ${X1CONSOLE_ORIGIN}/${script}
crontab ${GUEST_PROJECT}/${CRONTAB_FIXTURE}
cd ${X1CONSOLE_ORIGIN}
git init -q
git add ${script}
git diff --cached --quiet || ${COMMIT} -m "the x1console stand-in"
[ -d ${folder}/.git ] || git clone -q ${X1CONSOLE_ORIGIN} ${folder}
`;
}

/**
 * Writes the script that plays an Update X1 Console that brings a new
 * commit, as the container's user: the stand-in repository gains one,
 * then the checkout runs `git stash`, then `git pull`, as x1console
 * does. git runs the tool's hook only after a pull that brings new
 * commits.
 * @param {object} settings  The settings the tool loads in the container.
 * @returns {string}
 */
function x1consoleUpdate(settings) {
  const folder = homePath(settings.x1consoleDir, GUEST_HOME);
  return `set -e
cd ${X1CONSOLE_ORIGIN}
echo "an update" > update.txt
git add update.txt
${COMMIT} -m "an update"
cd ${folder}
git stash -q
git pull -q
`;
}

/**
 * Runs a command in the container as its user, in a real terminal, with
 * NODE_EXTRA_CA_CERTS set, and answers its prompts as each one appears.
 * @param {string} name  The container.
 * @param {string} command  The command, as the shell reads it.
 * @param {[string, string][]} answers  Each prompt's text, and its answer.
 * @returns {Promise<{code: number, output: string}>}
 */
function withAnswers(name, command, answers) {
  return answerInTerminal(name, command, answers, {
    NODE_EXTRA_CA_CERTS: NODE_CA,
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
    isPrivate === true ? "127.0.0.1" : "0.0.0.0",
    address,
    ...(isPrivate === true ? ["--private-rpc"] : []),
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
  console.log(`${holds === true ? "ok  " : "FAIL"}  ${what}`);
  if (holds === false) {
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
 * Lists the paths in the user's home and in the tool's own folder that a
 * run of apply might create in the container, from the app's own paths,
 * moved to where the project and the home folder sit there.
 * @param {object} settings  The settings the tool loads in the container.
 * @returns {string[]}
 */
function guestPathsOf(settings) {
  const local = featurePaths();
  return [
    hashedApiKeysPathOf(settings, GUEST_HOME),
    gitHookPathOf(settings, GUEST_HOME),
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
 * left, the firewall rule and both cron lines are gone while Autopilot's
 * job stays, nginx.service is no longer masked, and x1console's checkout
 * is as committed, with no backup beside the start script.
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
  const ruleLeft = firewallAllows(name, HTTPS_RULE);
  expect(failures, "undo-apply removed the firewall rule", !ruleLeft);
  const crontab = asUserCaptured(name, ["crontab", "-l"]).stdout;
  expect(
    failures,
    "undo-apply removed both cron lines",
    !crontab.includes(" ensure"),
  );
  const autopilot = fs.readFileSync(
    path.join(projectRoot(), CRONTAB_FIXTURE),
    "utf8",
  );
  const autopilotKept = crontab.includes(autopilot);
  expect(
    failures,
    "apply and undo-apply kept Autopilot's job in the crontab",
    autopilotKept,
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
 * undo-apply runs, and once nginx is purged, a second time. The rule
 * must still be there as the operator made it, with nothing apply made
 * left behind. The rule goes after.
 * @param {import("./_lxd-api-key-checks.js").Guest} guest  The container.
 * @param {object} watched  The paths apply might make, and those of
 *   them that were there before it ran.
 * @param {string[]} failures  Collects what's wrong.
 * @returns {Promise<void>}
 */
async function checkKeepsOperatorRule(guest, watched, failures) {
  const { name } = guest;
  const comment = "added by the operator";
  const operatorRule = `ufw allow ${HTTPS_RULE} comment '${comment}'`;
  const added = asRoot(name, ["ufw", "allow", HTTPS_RULE, "comment", comment]);
  mustPass(added, "Adding the operator's firewall rule");
  const cli = guestCli();
  const stopped = await withAnswers(name, `node ${cli} apply`, [
    AFFIRM_DISCLAIMER,
    ["Stage 2 of 8", "y\n"],
    ["Stage 3 of 8", "y\n"],
    ["Stage 4 of 8", "n\n"],
  ]);
  const foundRule = recordFoundRule(name);
  const undone = await withAnswers(name, `node ${cli} undo-apply`, [
    AFFIRM_DISCLAIMER,
  ]);
  const finished = await purgeThenUndo(guest);
  const left = leftovers(name, watched.paths, watched.before);
  for (const item of left) {
    console.error(`Left behind: ${item}`);
  }
  const ruleKept =
    stopped.code === 1 &&
    foundRule === true &&
    undone.code === 0 &&
    finished === true &&
    left.length === 0 &&
    ufwHolds(name, operatorRule);
  expect(
    failures,
    "undo-apply leaves a firewall rule that was there before apply, comment and all, while ufw is off",
    ruleKept,
  );
  const removed = asRoot(name, ["ufw", "delete", "allow", HTTPS_RULE]);
  mustPass(removed, "Removing the operator's firewall rule");
}

/**
 * Makes what the api keys' checks work with in the container.
 * @param {string} name  The container.
 * @param {string[]} failures  Collects what's wrong.
 * @returns {import("./_lxd-api-key-checks.js").Guest}
 */
function guestOf(name, failures) {
  return {
    name,
    cli: guestCli(),
    hostname: HOSTNAME,
    ca: NODE_CA,
    password: PASSWORD,
    answer: (command, answers) => withAnswers(name, command, answers),
    tool: (args) => tool(name, args),
    expect: (what, holds) => expect(failures, what, holds),
  };
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
  const guest = guestOf(name, failures);
  const { address, settings } = setUpValidator(name, settingsOf);
  const cli = guestCli();
  const guestPaths = guestPathsOf(settings);
  const paths = pathsTheToolMightCreate(settings, guestPaths);
  const before = existingPaths(name, paths);
  const watched = { paths, before };
  const applied = await withAnswers(name, `node ${cli} apply --yes`, [
    AFFIRM_DISCLAIMER,
    [NEW_PASSWORD_PROMPT, `${PASSWORD}\n`],
    [SAME_PASSWORD_PROMPT, `${PASSWORD}\n`],
    [SAVE_PASSWORD_QUESTION, "y\n"],
  ]);
  expect(failures, "apply finishes every stage", applied.code === 0);
  const [key] = keysIn(guest, applied.output);
  if (applied.code !== 0 || key === undefined || key === null) {
    expect(failures, "apply shows the first key's url, in full", false);
    return false;
  }
  const ruleAdded = firewallAllows(name, HTTPS_RULE);
  expect(failures, "apply added the firewall rule", ruleAdded);
  checkSavedPassword(guest, settings);
  const url = await withAnswers(name, `node ${cli} url`, []);
  expect(
    failures,
    "url prints the url's form and the number of keys, and asks nothing",
    url.code === 0 &&
      url.output.includes(`https://${HOSTNAME}/KEY`) &&
      url.output.includes("holds 1 api key."),
  );
  const reached = answersWith(guest, key, "200");
  expect(
    failures,
    "a client with the first key reaches the rpc through nginx",
    reached,
  );
  const randomKey = makeApiKey();
  const randomRefused = answersWith(guest, randomKey, "403");
  expect(failures, "a request with a random key gets 403", randomRefused);
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
  checkLogs(guest, key);
  checkOwnDev(guest, key);
  const beforeRestart = tool(name, ["ensure"]);
  expect(
    failures,
    "ensure finds the rpc public before the validator's restart",
    beforeRestart === 1,
  );
  startRpc(name, address, true);
  const allOk = everyCheckOk(name);
  expect(failures, "ensure finds every check ok after the restart", allOk);
  // The hook's ensure gets the pull's environment, and so trusts Pebble.
  const updated = asUser(name, ["sh", "-c", x1consoleUpdate(settings)], {
    NODE_EXTRA_CA_CERTS: NODE_CA,
  });
  mustPass(updated, "Updating x1console's checkout, as Update X1 Console does");
  const restored = readScript(name, settings);
  expect(
    failures,
    "the tool's git hook put --private-rpc back before an update's git pull returned",
    restored.includes(FLAG_LINE),
  );
  const restarted = asRoot(name, ["systemctl", "restart", NGINX_UNIT]);
  mustPass(restarted, "Restarting nginx");
  const afterRestart = tool(name, ["ensure", "--quiet"]);
  const stillWorks = answersWith(guest, key, "200") && afterRestart === 0;
  expect(
    failures,
    "after a restart of nginx, the key works, with no password",
    stillWorks,
  );
  checkLogFolderComesBack(guest, key);
  const third = await checkAddAndRemove(guest, key);
  const turnedOff = await withAnswers(
    name,
    `node ${cli} turn-off-private-rpc --yes`,
    [AFFIRM_DISCLAIMER],
  );
  const offScript = readScript(name, settings);
  expect(
    failures,
    "turn-off-private-rpc takes --private-rpc out",
    turnedOff.code === 0 && !offScript.includes(FLAG_LINE),
  );
  startRpc(name, address, false);
  const whileOff = tool(name, ["ensure"]);
  const leftOut = readScript(name, settings);
  expect(
    failures,
    "while private rpc is off, ensure accepts a public rpc and leaves the flag out",
    whileOff === 0 && !leftOut.includes(FLAG_LINE),
  );
  const turnedOn = await withAnswers(name, `node ${cli} turn-on-private-rpc`, [
    AFFIRM_DISCLAIMER,
  ]);
  const onScript = readScript(name, settings);
  expect(
    failures,
    "turn-on-private-rpc puts --private-rpc back",
    turnedOn.code === 0 && onScript.includes(FLAG_LINE),
  );
  startRpc(name, address, true);
  const allOkAgain = everyCheckOk(name);
  expect(
    failures,
    "ensure finds every check ok once the validator takes the flag again",
    allOkAgain,
  );
  const reapplied = await withAnswers(name, `node ${cli} apply --yes`, [
    AFFIRM_DISCLAIMER,
  ]);
  expect(
    failures,
    "a later apply asks for no password, and makes no key",
    reapplied.code === 0 &&
      !asksForPassword(reapplied.output) &&
      keysIn(guest, reapplied.output).length === 0,
  );
  await checkKeepsKeys(guest, [key, third], settings);
  const undone = await withAnswers(name, `node ${cli} undo-apply`, [
    AFFIRM_DISCLAIMER,
    [KEYS_AND_PASSWORD_QUESTION, "y\n"],
  ]);
  expect(failures, "undo-apply finishes", undone.code === 0);
  checkNginxStays(guest, undone.output);
  expect(
    failures,
    "after the operator purges nginx, a second undo-apply finishes",
    await purgeThenUndo(guest),
  );
  checkUndone(name, watched, settings, failures);
  await checkKeepsOperatorRule(guest, watched, failures);
  return failures.length === 0;
}
