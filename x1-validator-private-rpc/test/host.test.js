/**
 * @file x1-validator-private-rpc/test/host.test.js
 * @description
 * Tests the real host's functions without touching the machine's own
 * files: commands run as the test's user, sudo is replaced by a stand-in
 * that gains no privileges, files live in a temporary folder, and http
 * and https requests go to servers the test starts on 127.0.0.1, the
 * https one with a certificate openssl makes for the test.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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

test("makes a folder root owns with the group it's given", () => {
  const temp = makeTestTempFolder("host");
  const folder = path.join(temp, "logs");
  const primary = process.getgid();
  const others = process.getgroups().filter((gid) => gid !== primary);
  // Another of the user's groups, which the folder can't get by default.
  const group = others.length > 0 ? others[0] : primary;
  testHost().makeRootDir(folder, "0750", `${group}`);
  const made = fs.statSync(folder);
  assert.deepEqual([made.mode & 0o777, made.gid], [0o750, group]);
});

test("removes a root folder whole, or only once it's empty", () => {
  const host = testHost();
  const folder = path.join(makeTestTempFolder("host"), "logs");
  host.makeRootDir(path.join(folder, "old"), "0755");
  host.writeRootFile(path.join(folder, "old", "nginx-access.log"), "", "0644");
  host.removeRootDirIfEmpty(folder);
  assert.equal(fs.existsSync(folder), true);
  host.removeRootTree(folder);
  assert.equal(fs.existsSync(folder), false);
  host.removeRootTree(folder);
  host.makeRootDir(folder, "0755");
  host.removeRootDirIfEmpty(folder);
  assert.equal(fs.existsSync(folder), false);
  assert.throws(() => host.removeRootDirIfEmpty(folder), {
    message: /Removing/,
  });
});

test("reads, writes and checks files, and makes temporary folders", () => {
  const host = testHost();
  const folder = host.makeTempDir();
  const file = path.join(folder, "note.txt");
  host.writeText(file, "text");
  assert.equal(host.exists(file), true);
  assert.equal(host.readText(file), "text");
  host.removeUserTree(folder);
  assert.equal(host.exists(folder), false);
});

test("removes a folder of the account's own only once it's empty", () => {
  const host = testHost();
  const folder = path.join(makeTestTempFolder("host"), "vault");
  host.makeUserDir(folder, 0o700);
  host.writeUserFile(path.join(folder, "other.json"), "{}", 0o600);
  host.removeUserDirIfEmpty(folder);
  assert.equal(fs.existsSync(folder), true);
  host.removeUserFile(path.join(folder, "other.json"));
  host.removeUserDirIfEmpty(folder);
  assert.equal(fs.existsSync(folder), false);
  assert.throws(() => host.removeUserDirIfEmpty(folder), { code: "ENOENT" });
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

test("writes, reads and removes files the tool's own account owns, and leaves a folder's mode as it was", () => {
  const host = testHost();
  const folder = path.join(makeTestTempFolder("host-user-files"), "a", "b");
  host.makeUserDir(folder, 0o700);
  assert.equal(host.fileMode(folder), 0o700);
  // A folder that was there keeps its own mode.
  fs.chmodSync(folder, 0o750);
  host.makeUserDir(folder, 0o700);
  assert.equal(host.fileMode(folder), 0o750);
  const file = path.join(folder, "vault.json");
  host.writeUserFile(file, "first\n", 0o600);
  host.writeUserFile(file, "second\n", 0o600);
  assert.equal(host.readText(file), "second\n");
  assert.equal(host.fileMode(file), 0o600);
  assert.ok(Math.abs(host.modifiedAt(file) - Date.now()) < 60 * 1000);
  assert.equal(fs.existsSync(`${file}.x1-validator-private-rpc-new`), false);
  host.removeUserFile(file);
  assert.equal(host.exists(file), false);
  assert.ok(path.isAbsolute(host.homeDir()));
});

test("posts json and reads the answer; a slow server times out by its origin alone", async () => {
  let received = null;
  const { server, url } = await startServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received = {
        type: request.headers["content-type"],
        body: JSON.parse(body),
      };
      response.end('{"result":1}');
    });
  });
  try {
    const answer = await testHost().postJson(
      url,
      { method: "getHealth" },
      2000,
    );
    assert.deepEqual(answer, { status: 200, body: '{"result":1}' });
    assert.deepEqual(received, {
      type: "application/json",
      body: { method: "getHealth" },
    });
  } finally {
    server.close();
  }
  const { server: slow, url: slowUrl } = await startServer(() => {});
  try {
    await assert.rejects(
      testHost().postJson(`${slowUrl}/secret-path`, {}, 100),
      (error) => {
        assert.match(
          error.message,
          /^No answer from http:\/\/127\.0\.0\.1:\d+ in 100 ms\.$/,
        );
        return true;
      },
    );
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

test("asks an https server under a hostname, and reads its certificate", async (t) => {
  const folder = makeTestTempFolder("host-tls");
  const keyPath = path.join(folder, "key.pem");
  const certPath = path.join(folder, "cert.pem");
  const made = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-subj",
    "/CN=x1-rpc.example.com",
    "-addext",
    "subjectAltName=DNS:x1-rpc.example.com",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  if (made.status !== 0) {
    t.skip("openssl isn't installed");
    return;
  }
  const cert = fs.readFileSync(certPath, "utf8");
  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert },
    (request, response) => {
      response.end(`${request.headers.host} ${request.url}`);
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = {
    address: "127.0.0.1",
    port: server.address().port,
    hostname: "x1-rpc.example.com",
    path: "/x1-rpc-gate",
    timeoutMs: 2000,
  };
  try {
    const answer = await testHost().tlsGet({ ...target, ca: cert });
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "x1-rpc.example.com /x1-rpc-gate");
    assert.equal(answer.certificate.altNames, "DNS:x1-rpc.example.com");
    const daysLeft = (answer.certificate.validTo - Date.now()) / 86400000;
    assert.ok(daysLeft > 29 && daysLeft <= 30, String(daysLeft));
    await assert.rejects(testHost().tlsGet(target), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  } finally {
    server.close();
  }
});

test("looks up a name's ipv4 addresses, and lists the machine's own", async () => {
  const host = testHost();
  assert.ok((await host.lookupIpv4("localhost")).includes("127.0.0.1"));
  assert.ok(host.localIpv4Addresses().includes("127.0.0.1"));
});
