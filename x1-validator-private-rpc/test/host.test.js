/**
 * @file x1-validator-private-rpc/test/host.test.js
 * @description
 * Tests the real host's functions without touching the machine's own
 * files: commands run as the test's user, sudo is replaced by a stand-in
 * that gains no privileges, files live in a temporary folder, and http
 * requests go to a server the test starts on 127.0.0.1.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestTempFolder } from "../../scripts/_test-temp-folders.js";
import { createHost } from "../src/lib/host.js";

/**
 * Builds the host with the sudo stand-in.
 * @returns {object}
 */
function testHost() {
  const fakeSudo = fileURLToPath(
    new URL("./helpers/fake-sudo.js", import.meta.url),
  );
  return createHost({ sudoPrefix: [process.execPath, fakeSudo] });
}

/**
 * Starts an http server on 127.0.0.1 that answers with a handler.
 * @param {http.RequestListener} handler  Answers each request.
 * @returns {Promise<{server: http.Server, url: string}>}
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/x1-rpc-gate` });
    });
  });
}

test("runs a command, passing its input and capturing its output", () => {
  const result = testHost().run(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input: "hello" },
  );
  assert.deepEqual(result, { status: 0, stdout: "hello", stderr: "" });
});

test("gives a command that can't start exit code 127", () => {
  const result = testHost().run("x1-no-such-command", []);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /ENOENT/);
});

test("captures binary output as bytes", () => {
  const result = testHost().run(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.from([0, 255]))"],
    { binary: true },
  );
  assert.deepEqual([...result.stdout], [0, 255]);
});

test("runs a command through the sudo prefix", () => {
  const result = testHost().sudo(process.execPath, ["-e", "console.log(42)"]);
  assert.deepEqual(result, { status: 0, stdout: "42\n", stderr: "" });
});

test("runs a command through the sudo prefix without blocking", async () => {
  const result = await testHost().sudoAsync(process.execPath, [
    "-e",
    "console.log(42); console.error('note'); process.exit(3)",
  ]);
  assert.deepEqual(result, { status: 3, stdout: "42\n", stderr: "note\n" });
});

test("gives a command that can't start without blocking exit code 127", async () => {
  const host = createHost({ sudoPrefix: ["x1-no-such-sudo"] });
  const result = await host.sudoAsync("true", []);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /ENOENT/);
});

test("writes a file root owns in one rename, creating its folder", () => {
  const folder = makeTestTempFolder("host");
  const target = path.join(folder, "new", "nginx.conf");
  testHost().writeRootFile(target, "worker_processes 1;\n", "0640");
  assert.equal(fs.readFileSync(target, "utf8"), "worker_processes 1;\n");
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["nginx.conf"]);
});

test("makes and removes folders and files root owns", () => {
  const host = testHost();
  const folder = path.join(makeTestTempFolder("host"), "run");
  host.makeRootDir(folder, "0700");
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  const file = path.join(folder, "api-key");
  host.writeRootFile(file, "key", "0600");
  host.removeRootFile(file);
  host.removeRootDir(folder);
  assert.equal(fs.existsSync(folder), false);
  assert.throws(() => host.removeRootDir(folder), { message: /Removing/ });
});

test("reads, writes and checks files, and makes temporary folders", () => {
  const host = testHost();
  const folder = host.makeTempDir();
  const file = path.join(folder, "note.txt");
  host.writeText(file, "text");
  assert.equal(host.exists(file), true);
  assert.equal(host.readText(file), "text");
  host.removeTempDir(folder);
  assert.equal(host.exists(folder), false);
});

test("reads an http answer as text", async () => {
  const { server, url } = await startServer((request, response) => {
    response.end("unlocked\n");
  });
  try {
    assert.deepEqual(await testHost().httpGet(url, 2000), {
      status: 200,
      body: "unlocked\n",
    });
  } finally {
    server.close();
  }
});

test("gives up on an http server that doesn't answer in time", async () => {
  const { server, url } = await startServer(() => {});
  try {
    await assert.rejects(testHost().httpGet(url, 100), {
      message: /No answer from .* in 100 ms/,
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("reports a refused connection", async () => {
  const host = testHost();
  const port = await host.freeLoopbackPort();
  await assert.rejects(host.httpGet(`http://127.0.0.1:${port}/`, 1000), {
    code: "ECONNREFUSED",
  });
});

test("tells who and where it runs, and keeps time", async () => {
  const host = testHost();
  assert.equal(host.nodePath(), process.execPath);
  assert.equal(host.isRoot(), process.getuid() === 0);
  assert.equal(typeof host.userName(), "string");
  const start = host.now();
  await host.sleep(5);
  assert.ok(host.now() >= start);
});
