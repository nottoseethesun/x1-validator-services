/**
 * @file x1-validator-private-rpc/src/cli/apply-preflight.js
 * @description
 * apply's first stage, which changes nothing. It reads what the later
 * stages need: systemd's answer about a TPM2 chip, the rpc port from
 * x1console's start script, the validator's public address, and the
 * system's dns resolver. It stops, listing every problem at once, when
 * the machine isn't one the tool can set up: not Ubuntu 24.04 or later,
 * systemd older than 250, a tool missing, nginx installed by something
 * else, port 443 taken, a ufw rule that closes port 443, the address not
 * on this machine, the solana cli pointed at this validator, the
 * hostname pointing elsewhere, or Let's Encrypt out of reach.
 *
 * The public address is the `publicIp` setting when set; otherwise the
 * gossip address the X1 network has for this validator, which the local
 * rpc reports.
 */

import { installedVersion } from "../lib/apt.js";
import { parseOsRelease } from "../lib/os-release.js";
import { systemdVersion } from "../lib/systemd.js";
import { httpsRuleOf, httpsRuleProblem, packageKey } from "./apply-install.js";
import { homePath, startScriptPathOf } from "./feature-paths.js";
import { readStartScript } from "./start-script.js";
import { changedByApply } from "./what-apply-changed.js";

/** The oldest systemd with `systemd-creds`, which saving needs. */
const OLDEST_SYSTEMD = 250;

/** From this systemd on, `has-tpm2` belongs to `systemd-analyze`. */
const SYSTEMD_ANALYZE_TPM2 = 257;

/** The oldest Ubuntu release the tool sets up. */
const OLDEST_UBUNTU = 24.04;

/**
 * Where Ubuntu installs the system's programs. apply looks for its tools
 * there, not on the PATH, which may lack the sbin folders that hold ufw.
 */
const SYSTEM_BINARY_FOLDERS = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/** Where the solana cli keeps its settings, in the account's home. */
const SOLANA_CLI_CONFIG = "~/.config/solana/cli/config.yml";

/**
 * @typedef {object} Facts
 * @property {string} tpm2  systemd's answer about a TPM2 chip.
 * @property {string} startScriptPath  x1console's start script.
 * @property {number} rpcPort  The validator's rpc port.
 * @property {string} publicIp  The address nginx listens on.
 * @property {string} resolver  The system's dns resolver.
 * @property {string} codename  The Ubuntu release's code name.
 */

/**
 * Asks the local rpc one json-rpc question.
 * @param {object} host  The host.
 * @param {number} rpcPort  The rpc's port.
 * @param {string} method  Such as `getIdentity`.
 * @param {number} timeoutMs  How long to wait.
 * @returns {Promise<unknown>} The answer's result.
 * @throws {Error} When the rpc answers with anything but a result, since
 *   the caller has nothing to read then.
 */
export async function askRpc(host, rpcPort, method, timeoutMs) {
  const response = await host.postJson(
    `http://127.0.0.1:${rpcPort}`,
    { jsonrpc: "2.0", id: 1, method },
    timeoutMs,
  );
  const answer = response.status === 200 ? JSON.parse(response.body) : {};
  if (answer.result === undefined || answer.result === null) {
    throw new Error(
      `the rpc gave no result for ${method}, with http ${response.status}`,
    );
  }
  return answer.result;
}

/**
 * Finds the address the X1 network has for this validator: the gossip
 * address of its own identity.
 * @param {object} host  The host.
 * @param {number} rpcPort  The rpc's port.
 * @param {number} timeoutMs  How long to wait for each answer.
 * @returns {Promise<string|null>} The address, or null when the rpc
 *   doesn't answer or doesn't list this validator.
 */
async function gossipAddress(host, rpcPort, timeoutMs) {
  try {
    const { identity } = await askRpc(host, rpcPort, "getIdentity", timeoutMs);
    const nodes = await askRpc(host, rpcPort, "getClusterNodes", timeoutMs);
    const own = nodes.find((node) => node.pubkey === identity);
    return own?.gossip?.split(":")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the url the solana cli talks to, from its settings file.
 * @param {object} host  The host.
 * @returns {string|null} The url, or null when there are no settings.
 */
function cliUrl(host) {
  const homeDir = host.homeDir();
  const configPath = homePath(SOLANA_CLI_CONFIG, homeDir);
  if (!host.exists(configPath)) {
    return null;
  }
  const line = host
    .readText(configPath)
    .split("\n")
    .find((text) => text.startsWith("json_rpc_url:"));
  return line === undefined || line === null
    ? null
    : line.slice("json_rpc_url:".length).trim().replaceAll('"', "");
}

/**
 * Reads the system's dns resolver, the first nameserver in
 * /etc/resolv.conf: on Ubuntu, systemd-resolved's 127.0.0.53.
 * @param {object} host  The host.
 * @returns {string|null}
 */
function systemResolver(host) {
  const line = host
    .readText("/etc/resolv.conf")
    .split("\n")
    .find((text) => text.startsWith("nameserver "));
  return line === undefined || line === null ? null : line.split(/\s+/)[1];
}

/**
 * Checks the release, systemd and the tools apply runs.
 * @param {object} host  The host.
 * @param {string[]} problems  Collects what's wrong.
 * @returns {{version: number|null, codename: string, missing: string[]}}
 *   The tools missing among them too.
 */
function checkSystem(host, problems) {
  const osRelease = host.readText("/etc/os-release");
  const release = parseOsRelease(osRelease);
  const versionId = Number.parseFloat(release.get("VERSION_ID") ?? "0");
  if (release.get("ID") !== "ubuntu" || versionId < OLDEST_UBUNTU) {
    problems.push("This isn't Ubuntu 24.04 or later.");
  }
  const version = systemdVersion(host);
  if (version === null || version < OLDEST_SYSTEMD) {
    problems.push(
      `systemd ${OLDEST_SYSTEMD} or newer is needed, for systemd-creds; ` +
        `this machine has ${version ?? "an unknown version"}.`,
    );
  }
  const missing = ["apt", "ufw", "sudo", "gpg"].filter(
    (tool) =>
      !SYSTEM_BINARY_FOLDERS.some((folder) => host.exists(`${folder}/${tool}`)),
  );
  for (const tool of missing) {
    problems.push(`${tool} isn't installed.`);
  }
  return {
    version,
    codename: release.get("VERSION_CODENAME") ?? "",
    missing,
  };
}

/**
 * Checks that no ufw rule closes port 443, once sudo and ufw are there to
 * ask.
 * @param {object} host  The host.
 * @param {string[]} missing  The tools that are missing.
 * @param {string[]} problems  Collects what's wrong.
 */
function checkFirewall(host, missing, problems) {
  if (missing.includes("ufw") || missing.includes("sudo")) {
    return;
  }
  const rule = httpsRuleOf(host);
  const problem = httpsRuleProblem(rule);
  if (problem !== null) {
    problems.push(problem);
  }
}

/**
 * Checks that nginx is missing or apply's own, and that port 443 is free
 * or nginx's.
 * @param {object} host  The host.
 * @param {Map<string, object>} whatApplyChanged  apply's record.
 * @param {string[]} problems  Collects what's wrong.
 */
function checkNginx(host, whatApplyChanged, problems) {
  const ours = changedByApply(whatApplyChanged, packageKey("nginx"));
  const installed = installedVersion(host, "nginx");
  if (installed !== null && !ours) {
    problems.push(
      `nginx ${installed} is already installed, by something other than ` +
        "this tool, which doesn't share nginx with other sites.",
    );
  }
  const listening = host.run("ss", ["-ltnH", "sport = :443"]).stdout.trim();
  if (listening !== "" && !ours) {
    problems.push("Something already listens on port 443.");
  }
}

/**
 * Checks the address: on this machine, not the solana cli's, and where
 * the hostname points.
 * @param {object} host  The host.
 * @param {{hostname: string, publicIp: string}} names  The hostname and
 *   the public address.
 * @param {string[]} problems  Collects what's wrong.
 * @returns {Promise<void>}
 */
async function checkAddress(host, { hostname, publicIp }, problems) {
  if (!host.localIpv4Addresses().includes(publicIp)) {
    problems.push(
      `${publicIp} isn't on any of this machine's interfaces, so nginx ` +
        "can't listen on it. The tool doesn't set up servers behind " +
        "address translation.",
    );
  }
  const url = cliUrl(host);
  if (url !== null && (url.includes(publicIp) || url.includes(hostname))) {
    problems.push(
      `The solana cli's url, ${url}, names this validator. Under ` +
        "--private-rpc, Autopilot's health check would then fail and " +
        "wipe and restart the validator. Point the cli at X1's public rpc " +
        "first, from x1console's network menu.",
    );
  }
  let found;
  try {
    found = await host.lookupIpv4(hostname);
  } catch (error) {
    found = [`nothing (${error.message})`];
  }
  if (!found.includes(publicIp)) {
    problems.push(
      `${hostname} points to ${found.join(", ")}, not to ${publicIp}. ` +
        "Set its A record first, as docs/manual-domain-setup.md explains.",
    );
  }
}

/**
 * Runs the preflight.
 * @param {object} context  The run: host, settings, whatApplyChanged,
 *   overridePath, staging.
 * @returns {Promise<Facts>}
 * @throws {Error} Listing every problem, when there is any, so apply
 *   changes nothing on a machine it can't finish on, and the operator
 *   sees every problem at once.
 */
export async function preflight(context) {
  const { host, settings, whatApplyChanged, overridePath, staging } = context;
  const problems = [];
  const { version, codename, missing } = checkSystem(host, problems);
  checkFirewall(host, missing, problems);
  const tpm2 =
    version === null
      ? ""
      : host
          .run(
            version >= SYSTEMD_ANALYZE_TPM2
              ? "systemd-analyze"
              : "systemd-creds",
            ["has-tpm2"],
          )
          .stdout.trim();
  if (settings.hostname === undefined || settings.hostname === null) {
    problems.push(
      `Set hostname in ${overridePath}: the name your clients will use for ` +
        "the rpc, such as x1-rpc.example.com.",
    );
  }
  const homeDir = host.homeDir();
  const startScriptPath = startScriptPathOf(settings, homeDir);
  let rpcPort = null;
  try {
    const script = host.readText(startScriptPath);
    rpcPort = readStartScript(script, startScriptPath).rpcPort;
  } catch (error) {
    problems.push(error.message);
  }
  checkNginx(host, whatApplyChanged, problems);
  const timeoutMs = settings.requestTimeoutSeconds * 1000;
  const publicIp =
    settings.publicIp ??
    (rpcPort === null ? null : await gossipAddress(host, rpcPort, timeoutMs));
  if (publicIp === null) {
    problems.push(
      "The local rpc didn't say which address the X1 network has for this " +
        `validator. Set publicIp in ${overridePath}.`,
    );
  } else if (settings.hostname !== undefined && settings.hostname !== null) {
    await checkAddress(
      host,
      { hostname: settings.hostname, publicIp },
      problems,
    );
  }
  const directory = staging
    ? settings.acmeStagingDirectoryUrl
    : settings.acmeDirectoryUrl;
  const reached = await host
    .httpsGet(directory, timeoutMs)
    .catch((error) => ({ status: 0, body: error.message }));
  if (reached.status !== 200) {
    const why = reached.status === 0 ? reached.body : `http ${reached.status}`;
    problems.push(
      `${directory} didn't answer (${why}), and nginx must reach it for ` +
        "the certificate.",
    );
  }
  const resolver = systemResolver(host);
  if (resolver === null) {
    problems.push("/etc/resolv.conf names no nameserver for nginx to use.");
  }
  if (problems.length > 0) {
    throw new Error(
      `apply can't go on:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
  }
  return { tpm2, startScriptPath, rpcPort, publicIp, resolver, codename };
}
