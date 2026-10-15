import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { constants, deflateRawSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { createUnixWebSocket } from "../src/unix-websocket.js";

function event(target, name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timeout);
      target.removeEventListener(name, received);
      target.removeEventListener("error", failed);
      callback(value);
    };
    const received = (value) => finish(resolve, value);
    const failed = (value) => {
      if (name !== "close") finish(reject, value.error ?? new Error("WebSocket connection failed"));
    };
    const timeout = setTimeout(() => finish(reject, new Error(`Timed out waiting for ${name}`)), timeoutMs);
    target.addEventListener(name, received);
    target.addEventListener("error", failed);
  });
}

async function fixture(t, { connected, handleRequest, upgrade } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex native 'ws-"));
  const socketPath = path.join(directory, "server:socket");
  const server = createServer(handleRequest);
  const sockets = new Set();
  const connections = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    // Raw upgrade handlers inherit HTTP's half-open sockets. Finish the server
    // side too when a rejected or cancelled client closes its write side.
    socket.on("end", () => socket.end());
    socket.on("close", () => sockets.delete(socket));
  });
  let webSockets;
  if (upgrade) {
    server.on("upgrade", upgrade);
  } else if (!handleRequest) {
    webSockets = new WebSocketServer({ server, perMessageDeflate: true });
    webSockets.on("connection", connected ?? (() => {}));
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const connection of connections) connection.terminate();
    for (const socket of webSockets?.clients ?? []) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (webSockets) await new Promise((resolve) => webSockets.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sockets,
    connect(options) {
      const connection = createUnixWebSocket(socketPath, options);
      connections.push(connection);
      return connection;
    },
  };
}

test("native WebSocket exchanges immediate and fragmented messages over a Unix socket", { timeout: 4000 }, async (t) => {
  let peer;
  let pong;
  const server = await fixture(t, {
    connected(socket) {
      peer = socket;
      pong = once(socket, "pong", { signal: AbortSignal.timeout(2000) });
      socket.send("immediate notification");
      socket.ping("health");
      socket.on("message", (data) => {
        socket.send(data.subarray(0, 8), { binary: false, fin: false });
        socket.send(data.subarray(8), { binary: false, fin: true });
      });
    },
  });
  const { socket } = server.connect();
  assert.ok(socket instanceof globalThis.WebSocket);
  const messages = [];
  const reply = new Promise((resolve) => {
    socket.addEventListener("message", ({ data }) => {
      messages.push(data);
      if (data === "hello 🐈") resolve();
    });
  });
  await event(socket, "open");
  assert.equal(peer.extensions, "", "compression must remain disabled");
  socket.send("hello 🐈");
  await reply;
  assert.deepEqual(messages, ["immediate notification", "hello 🐈"]);
  assert.equal((await pong)[0].toString(), "health");
  const closed = event(socket, "close");
  socket.close(1000);
  assert.equal((await closed).wasClean, true);
});

test("native WebSocket enforces the existing 1 MiB message limit", { timeout: 4000 }, async (t) => {
  const server = await fixture(t, {
    connected(socket) {
      socket.on("message", () => socket.send("x".repeat(1024 * 1024 + 1)));
    },
  });
  const { socket } = server.connect();
  await event(socket, "open");
  const closed = event(socket, "close");
  let received = false;
  socket.addEventListener("message", () => { received = true; });
  socket.send("send oversized response");
  assert.equal((await closed).wasClean, false);
  assert.equal(received, false);
});

test("a ping between fragments cannot bypass the 1 MiB delivery limit", { timeout: 4000 }, async (t) => {
  const server = await fixture(t, {
    connected(socket) {
      socket.on("message", () => {
        const [transport] = server.sockets;
        transport.cork();
        socket.send("x".repeat(1024 * 1024), { fin: false });
        socket.ping();
        socket.send("x", { fin: true });
        socket.send("buffered follow-up message");
        transport.uncork();
      });
    },
  });
  const { socket } = server.connect();
  await event(socket, "open");
  let received = false;
  socket.addEventListener("message", () => {
    received = true;
    socket.close(1000);
  });
  const closed = event(socket, "close");
  socket.send("send fragmented response");
  await closed;
  assert.equal(received, false, "oversized messages and buffered follow-up messages must not reach application listeners");
});

test("the transport rejects compression even when a peer offers it without being asked", { timeout: 4000 }, async (t) => {
  const server = await fixture(t, {
    upgrade(request, socket) {
      assert.equal(request.headers["sec-websocket-extensions"], undefined);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const compressed = deflateRawSync(Buffer.from("unexpected compression"), {
        flush: constants.Z_SYNC_FLUSH,
        finishFlush: constants.Z_SYNC_FLUSH,
      }).subarray(0, -4);
      socket.write(Buffer.concat([
        Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`),
        Buffer.from([0xc1, compressed.length]),
        compressed,
      ]));
    },
  });
  const { socket } = server.connect();
  const closed = event(socket, "close");
  await assert.rejects(event(socket, "open"));
  await closed;
});

test("rejected HTTP upgrades and invalid handshake hashes close their sockets", { timeout: 4000 }, async (t) => {
  for (const response of [
    "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid\r\n\r\n",
  ]) {
    await t.test(response.split("\r\n")[0], async (subtest) => {
      let disconnected;
      const server = await fixture(subtest, {
        upgrade(_request, socket) {
          disconnected = new Promise((resolve) => socket.on("close", resolve));
          socket.write(response);
        },
      });
      const { socket } = server.connect();
      const closed = event(socket, "close");
      await assert.rejects(event(socket, "open"));
      await closed;
      assert.ok(disconnected, "the server must receive the upgrade request");
      await disconnected;
      assert.equal(server.sockets.size, 0);
    });
  }
});

test("a stalled handshake times out and destroys the pending HTTP connection", { timeout: 4000 }, async (t) => {
  let disconnected;
  const server = await fixture(t, {
    handleRequest(request) {
      disconnected = new Promise((resolve) => request.socket.on("close", resolve));
    },
  });
  const started = Date.now();
  const { socket } = server.connect({ handshakeTimeout: 100 });
  const closed = event(socket, "close");
  await assert.rejects(event(socket, "open"));
  await closed;
  assert.ok(disconnected, "the server must receive the handshake request");
  await disconnected;
  assert.ok(Date.now() - started >= 75, "the configured handshake deadline must expire");
  assert.ok(Date.now() - started < 1500);
  assert.equal(server.sockets.size, 0);
});

test("terminating before a handshake completes cancels the native connection", { timeout: 4000 }, async (t) => {
  const server = await fixture(t, { handleRequest() {} });
  const connection = server.connect();
  const closed = event(connection.socket, "close");
  connection.terminate();
  await closed;
  assert.equal(connection.socket.readyState, WebSocket.CLOSED);
  assert.equal(server.sockets.size, 0);
});
