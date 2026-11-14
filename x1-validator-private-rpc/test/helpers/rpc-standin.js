/**
 * @file x1-validator-private-rpc/test/helpers/rpc-standin.js
 * @description
 * A stand-in for Tachyon's rpc, for the LXD system test; never for a
 * validator. It listens on an address's port 8899 for json-rpc and
 * `/health`, and on port 8900 for websocket clients, as the validator's
 * rpc does: on every interface without `--private-rpc`, or on 127.0.0.1
 * with it. It reports one identity, whose gossip address is the public
 * address given, so apply finds that address as on a validator. Given
 * `--private-rpc`, it carries the flag in its command line, where
 * ensure looks for it.
 *
 * Usage: node rpc-standin.js BIND_ADDRESS PUBLIC_IP [--private-rpc]
 */

import http from "node:http";
import net from "node:net";

const RPC_PORT = 8899;
const IDENTITY = "StandinIdentity111111111111111111111111111111";

/**
 * Answers one json-rpc request.
 * @param {{method?: string}} request  The request.
 * @param {string} publicIp  The gossip address to report.
 * @returns {unknown} The result.
 */
function result(request, publicIp) {
  const results = new Map([
    ["getIdentity", { identity: IDENTITY }],
    ["getClusterNodes", [{ pubkey: IDENTITY, gossip: `${publicIp}:8001` }]],
    ["getHealth", "ok"],
  ]);
  return results.get(request.method ?? "") ?? null;
}

/**
 * Starts the stand-in.
 * @param {string[]} args  BIND_ADDRESS, PUBLIC_IP and maybe --private-rpc.
 */
function main(args) {
  const [bindAddress, publicIp] = args;
  const rpc = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url === "/health") {
        response.end("ok");
        return;
      }
      const parsed = body === "" ? {} : JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id ?? 1,
          result: result(parsed, publicIp),
        }),
      );
    });
  });
  rpc.listen(RPC_PORT, bindAddress);
  const websocket = net.createServer((socket) => socket.end());
  websocket.listen(RPC_PORT + 1, bindAddress);
}

main(process.argv.slice(2));
