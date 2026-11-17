/**
 * @file x1-validator-private-rpc/test/helpers/reload-probe.js
 * @description
 * A probe for the LXD system test, never for a validator. With one api
 * key, it opens each kind of connection a client can keep open to
 * nginx: an http/1.1 connection kept alive, an http/2 connection and a
 * websocket. It prints `ready` once each has worked. When a line comes
 * on its input, which the system test sends once it has removed the
 * key, it waits until a new connection gets 403, and a moment more for
 * nginx's old worker to take its signal. Then it sends a request again on
 * the kept-alive and http/2 connections, waits for the websocket to close,
 * and prints one line of json:
 *
 * - keepAlive and http2: the second answer's status, or "closed" when
 *   nginx closed the connection instead of answering
 * - websocketClosedAfterMs: how long after the line the websocket
 *   closed, or -1 when it was still open WAIT_MS after it
 *
 * Usage: node reload-probe.js HOSTNAME KEY CA_FILE
 */

import fs from "node:fs";
import http2 from "node:http2";
import tls from "node:tls";

/** How long the probe waits for each thing it expects. */
const WAIT_MS = 30000;

/** How long it gives nginx's old worker to take its shutdown signal. */
const SETTLE_MS = 1000;

/** How long it waits between two looks. */
const POLL_MS = 250;

/** The headers that ask nginx for a websocket. */
const UPGRADE =
  "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
  "Sec-WebSocket-Version: 13\r\n";

/**
 * Waits a while.
 * @param {number} ms  How long.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens an http/1.1 connection to nginx, under the hostname.
 * @param {string} hostname  The rpc's hostname.
 * @param {Buffer} ca  The roots to trust.
 * @returns {Promise<tls.TLSSocket>} The connection, open or failed.
 */
function connect(hostname, ca) {
  const socket = tls.connect({
    host: hostname,
    port: 443,
    servername: hostname,
    ca,
    ALPNProtocols: ["http/1.1"],
  });
  socket.on("error", () => {});
  return new Promise((resolve) => {
    socket.once("secureConnect", () => resolve(socket));
    socket.once("close", () => resolve(socket));
  });
}

/**
 * Sends one GET on an http/1.1 connection, and reads its answer's head
 * and body.
 * @param {tls.TLSSocket} socket  The connection.
 * @param {string} hostname  The rpc's hostname.
 * @param {string} urlPath  The path.
 * @param {string} [headers]  More headers, each ending in CRLF.
 * @returns {Promise<string>} The status, or "closed".
 */
function ask(socket, hostname, urlPath, headers = "") {
  return new Promise((resolve) => {
    let text = "";
    const done = (answer) => {
      socket.off("data", read);
      socket.off("close", closed);
      resolve(answer);
    };
    const read = (chunk) => {
      text += chunk;
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const status = text.split(" ")[1];
      const head = text.slice(0, end);
      const length = /content-length: *(\d+)/i.exec(head);
      const body = text.length - end - 4;
      const whole =
        length === undefined || length === null
          ? text.endsWith("0\r\n\r\n")
          : body >= Number(length[1]);
      if (status === "101" || whole === true) {
        done(status);
      }
    };
    const closed = () => done("closed");
    if (socket.destroyed === true) {
      done("closed");
      return;
    }
    socket.on("data", read);
    socket.on("close", closed);
    socket.write(
      `GET ${urlPath} HTTP/1.1\r\nHost: ${hostname}\r\n${headers}\r\n`,
    );
  });
}

/**
 * Sends one GET on an http/2 connection, and reads its status.
 * @param {http2.ClientHttp2Session} session  The connection.
 * @param {string} urlPath  The path.
 * @returns {Promise<string>} The status, or "closed".
 */
function askHttp2(session, urlPath) {
  return new Promise((resolve) => {
    let stream;
    try {
      stream = session.request({ ":path": urlPath });
    } catch {
      resolve("closed");
      return;
    }
    stream.on("response", (headers) => {
      const status = String(headers[":status"]);
      resolve(status);
    });
    stream.on("error", () => resolve("closed"));
    stream.on("close", () => resolve("closed"));
    stream.resume();
    stream.end();
  });
}

/**
 * Waits until a new connection's request gets 403: nginx then holds the
 * new list.
 * @param {string} hostname  The rpc's hostname.
 * @param {Buffer} ca  The roots to trust.
 * @param {string} urlPath  The keyed path.
 * @returns {Promise<void>}
 */
async function untilRefused(hostname, ca, urlPath) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const socket = await connect(hostname, ca);
    const status = await ask(socket, hostname, urlPath);
    socket.destroy();
    if (status === "403") {
      return;
    }
    await sleep(POLL_MS);
  }
}

/**
 * Runs the probe.
 * @param {string[]} args  HOSTNAME, KEY and CA_FILE.
 * @returns {Promise<void>}
 */
async function main([hostname, key, caFile]) {
  const ca = fs.readFileSync(caFile);
  const health = `/${key}/health`;
  const keptAlive = await connect(hostname, ca);
  const firstKeptAlive = await ask(keptAlive, hostname, health);
  const session = http2.connect(`https://${hostname}`, { ca });
  session.on("error", () => {});
  const firstHttp2 = await askHttp2(session, health);
  const websocket = await connect(hostname, ca);
  let closedAt = -1;
  websocket.on("close", () => {
    closedAt = Date.now();
  });
  const upgraded = await ask(websocket, hostname, `/${key}/`, UPGRADE);
  const first = [firstKeptAlive, firstHttp2, upgraded];
  if (first.join() !== "200,200,101") {
    const failed = JSON.stringify({ first });
    console.log(failed);
    process.exit(1);
  }
  console.log("ready");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  const removedAt = Date.now();
  await untilRefused(hostname, ca, health);
  await sleep(SETTLE_MS);
  const keepAlive = await ask(keptAlive, hostname, health);
  const second = await askHttp2(session, health);
  while (closedAt === -1 && Date.now() < removedAt + WAIT_MS) {
    await sleep(POLL_MS);
  }
  const websocketClosedAfterMs = closedAt === -1 ? -1 : closedAt - removedAt;
  const report = { keepAlive, http2: second, websocketClosedAfterMs };
  const line = JSON.stringify(report);
  console.log(line);
  process.exit(0);
}

main(process.argv.slice(2));
