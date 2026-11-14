/**
 * @file x1-validator-private-rpc/src/cli/checks.js
 * @description
 * ensure's checks, each reported as ok, problem or unknown, with a line
 * that says what was found. They're the cheap ones from the hand-off's
 * Verification Checks:
 *
 * - The start script carries `--private-rpc`.
 * - The running validator carries it too: the process that listens on
 *   the rpc port, found by that port and never by a name pattern.
 * - The rpc and its websocket listen on 127.0.0.1 alone.
 * - The start wrapper's Node.js and `src/cli.js` still exist.
 * - nginx is active, and listens on the public address's port 443 alone.
 * - The gate page says unlocked.
 * - The certificate is valid for the hostname, with enough days left.
 *
 * Reading the machine goes through the host; every judgment is a pure
 * function of what was read, so tests feed it captured output.
 */

import { GATE_PAGE_PATH } from "../lib/gate-page.js";
import { NGINX_UNIT } from "../lib/nginx-org.js";
import { askNginx } from "./nginx-gate.js";
import { readStartScript } from "./start-script.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} Check
 * @property {string} name  The check, such as `flag-in-script`.
 * @property {"ok"|"problem"|"unknown"} status  The verdict.
 * @property {string} detail  What was found, in words.
 */

/**
 * Reads the listening sockets in `ss -ltnH` or `ss -ltnpH` output.
 * @param {string} text  The output.
 * @returns {{address: string, port: number, pid: number|null}[]} Each
 *   socket's local address, without an interface's `%name` suffix; its
 *   port; and its process, when ss names one.
 */
export function parseListeners(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const local = fields[3] ?? "";
      const colon = local.lastIndexOf(":");
      const pid = /pid=(\d+)/.exec(line);
      return {
        address: local.slice(0, colon).split("%")[0],
        port: Number.parseInt(local.slice(colon + 1), 10),
        pid: pid === null ? null : Number.parseInt(pid[1], 10),
      };
    });
}

/**
 * Judges the rpc's listeners: only 127.0.0.1 may hold the rpc port and
 * the websocket port.
 * @param {{address: string, port: number}[]} listeners  Their sockets.
 * @param {number} rpcPort  The rpc port; the websocket's is the next.
 * @returns {Check}
 */
export function judgeRpcListeners(listeners, rpcPort) {
  const ports = [rpcPort, rpcPort + 1];
  const exposed = listeners.filter(
    (socket) => ports.includes(socket.port) && socket.address !== "127.0.0.1",
  );
  if (exposed.length > 0) {
    const where = exposed.map((socket) => `${socket.address}:${socket.port}`);
    return {
      name: "rpc-private",
      status: "problem",
      detail: `The rpc listens on ${where.join(" and ")}, so anyone can reach it.`,
    };
  }
  const listening = listeners.some((socket) => socket.port === rpcPort);
  return {
    name: "rpc-private",
    status: listening ? "ok" : "unknown",
    detail: listening
      ? "The rpc listens on 127.0.0.1 alone."
      : "Nothing listens on the rpc port: the validator isn't running.",
  };
}

/**
 * Judges nginx's listeners: the public address's port 443 alone, and
 * nothing on port 80.
 * @param {{address: string, port: number}[]} listeners  The sockets on
 *   ports 80 and 443.
 * @param {string} publicIp  The public address.
 * @returns {Check}
 */
export function judgeNginxListeners(listeners, publicIp) {
  const wrong = listeners.filter(
    (socket) => !(socket.port === 443 && socket.address === publicIp),
  );
  const right = listeners.some(
    (socket) => socket.port === 443 && socket.address === publicIp,
  );
  if (wrong.length > 0 || !right) {
    const found = listeners.map((socket) => `${socket.address}:${socket.port}`);
    return {
      name: "nginx-listens",
      status: "problem",
      detail: `Port 80 or 443 is held other than as ${publicIp}:443 alone: ${found.join(", ") || "nothing"}.`,
    };
  }
  return {
    name: "nginx-listens",
    status: "ok",
    detail: `nginx listens on ${publicIp}:443 alone.`,
  };
}

/**
 * Judges the certificate nginx serves.
 * @param {{validTo: number, altNames: string}|null} certificate  The
 *   certificate, or null when the tls check failed.
 * @param {object} values  What to judge it against.
 * @param {string} values.hostname  The rpc's hostname.
 * @param {number} values.now  The time now, in milliseconds.
 * @param {number} values.warningDays  How many days left is too few.
 * @param {string} values.failure  Why the tls check failed, if it did.
 * @returns {Check}
 */
export function judgeCertificate(certificate, values) {
  const { hostname, now, warningDays, failure } = values;
  if (certificate === null) {
    return {
      name: "certificate",
      status: "problem",
      detail: `The tls check failed: ${failure}`,
    };
  }
  const daysLeft = Math.floor((certificate.validTo - now) / DAY_MS);
  const named = certificate.altNames
    .split(",")
    .map((name) => name.trim())
    .includes(`DNS:${hostname}`);
  const good = named && daysLeft >= warningDays;
  return {
    name: "certificate",
    status: good ? "ok" : "problem",
    detail: named
      ? `The certificate has ${daysLeft} days left.`
      : `The certificate isn't for ${hostname}.`,
  };
}

/**
 * Judges the gate page's answer: unlocked is ok, locked a problem, and
 * no answer unknown, since the nginx and certificate checks say why.
 * @param {string} gate  The answer.
 * @returns {Check}
 */
export function judgeGate(gate) {
  const statuses = new Map([
    ["unlocked", "ok"],
    ["locked", "problem"],
  ]);
  return {
    name: "gate",
    status: statuses.get(gate) ?? "unknown",
    detail: `The gate page says ${gate}.`,
  };
}

/**
 * Finds whether the validator's running command carries the flag.
 * @param {object} host  The host.
 * @param {number} rpcPort  The rpc port.
 * @returns {Check}
 */
export function runningFlag(host, rpcPort) {
  const listed = host.run("ss", ["-ltnpH", `sport = :${rpcPort}`]);
  const sockets = parseListeners(listed.stdout);
  const pid = sockets.find((socket) => socket.pid !== null)?.pid;
  if (pid === undefined || pid === null) {
    return {
      name: "flag-running",
      status: "unknown",
      detail: "No process of this account listens on the rpc port.",
    };
  }
  const words = host.readText(`/proc/${pid}/cmdline`).split("\0");
  const flagged = words.includes("--private-rpc");
  return {
    name: "flag-running",
    status: flagged ? "ok" : "problem",
    detail: flagged
      ? "The running validator carries --private-rpc."
      : "The running validator lacks --private-rpc; restart it to take the flag.",
  };
}

/**
 * Finds whether the start wrapper's Node.js and `src/cli.js` exist.
 * @param {object} host  The host.
 * @param {string} wrapperPath  The start wrapper.
 * @returns {Check}
 */
function wrapperPaths(host, wrapperPath) {
  const text = host.exists(wrapperPath) ? host.readText(wrapperPath) : "";
  const named = ["NODE_BIN", "TOOL_CLI"].map((name) => {
    const line = text.split("\n").find((entry) => entry.startsWith(`${name}=`));
    return line === undefined || line === null
      ? ""
      : line.slice(name.length + 2, -1);
  });
  const missing = named.filter((value) => value === "" || !host.exists(value));
  return {
    name: "wrapper-paths",
    status: missing.length === 0 ? "ok" : "problem",
    detail:
      missing.length === 0
        ? "The start wrapper's Node.js and src/cli.js exist."
        : "A path in the start wrapper is gone; a saved-password start will " +
          "leave nginx locked. Run apply again to write them anew.",
  };
}

/**
 * Runs every check ensure makes.
 * @param {object} context  The run: host, settings, setup, target and
 *   startScriptPath.
 * @returns {Promise<Check[]>}
 */
export async function runChecks(context) {
  const { host, settings, setup, target, startScriptPath } = context;
  let flagInScript;
  try {
    const text = host.readText(startScriptPath);
    const script = readStartScript(text, startScriptPath);
    flagInScript = script.hasFlag;
  } catch {
    flagInScript = false;
  }
  const active = host.run("systemctl", ["is-active", NGINX_UNIT]).stdout.trim();
  let gate;
  let certificate = null;
  let failure = "";
  try {
    const answer = await askNginx(host, target, GATE_PAGE_PATH);
    gate = answer.status === 200 ? answer.body.trim() : `http ${answer.status}`;
    certificate = answer.certificate;
  } catch (error) {
    gate = `no answer (${error.message})`;
    failure = error.message;
  }
  const rpcListed = host.run("ss", [
    "-ltnH",
    `( sport = :${setup.rpcPort} or sport = :${setup.rpcPort + 1} )`,
  ]);
  const rpcSockets = parseListeners(rpcListed.stdout);
  const webListed = host.run("ss", [
    "-ltnH",
    "( sport = :443 or sport = :80 )",
  ]);
  const webSockets = parseListeners(webListed.stdout);
  const now = host.now();
  return [
    {
      name: "flag-in-script",
      status: flagInScript ? "ok" : "problem",
      detail: flagInScript
        ? "The start script carries --private-rpc."
        : "The start script lacks --private-rpc.",
    },
    runningFlag(host, setup.rpcPort),
    judgeRpcListeners(rpcSockets, setup.rpcPort),
    wrapperPaths(host, settings.startWrapperPath),
    {
      name: "nginx-active",
      status: active === "active" ? "ok" : "problem",
      detail: `nginx is ${active || "unknown"}.`,
    },
    judgeNginxListeners(webSockets, setup.publicIp),
    judgeGate(gate),
    active === "active"
      ? judgeCertificate(certificate, {
          hostname: setup.hostname,
          now,
          warningDays: settings.certificateWarningDays,
          failure,
        })
      : {
          name: "certificate",
          status: "unknown",
          detail: "nginx isn't running, so its certificate can't be read.",
        },
  ];
}
