import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";
import { AppServerObserver } from "../src/app-server-observer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "codex-keep-awake.js");

function runCli(args, dataDir, input = "", extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const inputPath = path.join(dataDir, `hook-input-${randomUUID()}.json`);
    writeFile(inputPath, input, { mode: 0o600 }).then(() => {
      const descriptor = openSync(inputPath, "r");
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        env: { ...process.env, PLUGIN_ROOT: repoRoot, PLUGIN_DATA: dataDir, ...extraEnv },
        stdio: [descriptor, "pipe", "pipe"],
      });
      closeSync(descriptor);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        rm(inputPath, { force: true }).finally(() => resolve({ code, stdout, stderr }));
      });
    }).catch(reject);
  });
}

async function waitFor(readValue, predicate, timeoutMs = 1800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readValue();
}

async function readRuntimeState(dataDir) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

async function processIsRunning(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (!stat) return false;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  return fields[0] !== "Z";
}

async function startProtocolServer(socketPath, respond) {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });
  webSockets.on("connection", (webSocket) => {
    webSocket.on("message", (raw) => respond(webSocket, JSON.parse(raw.toString())));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    clients: webSockets.clients,
    async close() {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => webSockets.close(resolve));
    },
  };
}

function respondToRead(webSocket, message, status = { type: "active", activeFlags: [] }) {
  if (message.method === "initialize") {
    webSocket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "test" } } }));
  } else if (message.method === "thread/read") {
    webSocket.send(JSON.stringify({
      id: message.id,
      result: { thread: { id: message.params.threadId, status } },
    }));
  }
}

test("app-server waits release portal leases and resume before a completion hook", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-observer-"));
  const socketPath = path.join(dataDir, "app-server.sock");
  const markerPath = path.join(dataDir, "inhibitor.active");
  const reasonPath = path.join(dataDir, "inhibitor.reason.txt");
  const pidPath = path.join(dataDir, "inhibitor.pid");

  let threadStatus = { type: "active", activeFlags: [] };
  const requests = [];
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });
  webSockets.on("connection", (webSocket) => {
    webSocket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      respondToRead(webSocket, message, threadStatus);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const threadId = "thr-observer-regression";
  const environment = {
    CODEX_KEEP_AWAKE_SOCKET: socketPath,
    CODEX_KEEP_AWAKE_TEST_PORTAL_DBUS_MODULE: path.join(repoRoot, "test", "helpers", "fake-portal-dbus.cjs"),
    CODEX_KEEP_AWAKE_TEST_PORTAL_MARKER: markerPath,
    CODEX_KEEP_AWAKE_TEST_PORTAL_REASON_FILE: reasonPath,
    CODEX_KEEP_AWAKE_TEST_PORTAL_PID_FILE: pidPath,
  };
  try {
    const hook = await runCli(["hook"], dataDir, JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: threadId,
      turn_id: "turn-active",
    }), environment);
    assert.equal(hook.code, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});

    const acquired = await waitFor(
      () => readRuntimeState(dataDir),
      (state) => state?.runtime?.appServerConnected && state.runtime.inhibitionActive,
    );
    assert.equal(acquired?.runtime?.protectionRequired, true);
    assert.equal(acquired?.runtime?.inhibitionBackend, "xdg-desktop-portal");
    assert.equal(acquired?.runtime?.inhibitionVerified, false);
    await waitFor(async () => readFile(markerPath, "utf8").then(() => true).catch(() => false), (exists) => exists);
    assert.equal(await readFile(reasonPath, "utf8"), "Codex is running active work\n");
    assert.equal(Number(await readFile(pidPath, "utf8")), acquired.supervisor.pid,
      "the long-lived supervisor owns the portal connection directly");

    const approvalStartedAt = Date.now();
    threadStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
    const waiting = await waitFor(
      () => readRuntimeState(dataDir),
      (state) => state?.threads?.[threadId]?.waiting === "approval"
        && state.runtime?.protectionRequired === false,
    );
    const approvalObservedMs = Date.now() - approvalStartedAt;
    assert.ok(approvalObservedMs < 2000, `approval wait observed after ${approvalObservedMs} ms`);
    assert.equal(waiting?.runtime?.appServerConnected, true);
    const releaseStartedAt = Date.now();
    await waitFor(async () => readFile(markerPath, "utf8").then(() => true).catch(() => false), (exists) => !exists);
    assert.ok(Date.now() - releaseStartedAt < 2000, "portal lease should close within two seconds of an approval wait");

    // Approval resumes in the app-server before any completion hook arrives.
    const resumeStartedAt = Date.now();
    threadStatus = { type: "active", activeFlags: [] };
    const resumed = await waitFor(
      () => readRuntimeState(dataDir),
      (state) => state?.runtime?.protectionRequired === true && state.runtime.inhibitionActive,
    );
    const resumeObservedMs = Date.now() - resumeStartedAt;
    assert.ok(resumeObservedMs < 2000, `resumed execution observed after ${resumeObservedMs} ms`);
    assert.equal(resumed?.threads?.[threadId]?.waiting, null);
    assert.ok(requests.some((message) => message.method === "thread/read" && message.params.includeTurns === false));

    process.kill(resumed.supervisor.pid, "SIGKILL");
    const supervisorRunning = await waitFor(() => processIsRunning(resumed.supervisor.pid), (running) => !running);
    assert.equal(supervisorRunning, false, "the process owning the portal connection should exit on a crash");
    await rm(markerPath, { force: true });
    const stoppedStatus = await runCli(["status"], dataDir, "", environment);
    const stoppedResponse = JSON.parse(stoppedStatus.stdout);
    assert.equal(stoppedResponse.running, false);
    assert.equal(stoppedResponse.runtime.degradedReason, "supervisor_not_running");
    assert.equal(stoppedResponse.runtime.inhibitionActive, false);
  } finally {
    await runCli(["cleanup"], dataDir, "", environment).catch(() => {});
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => webSockets.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("observer reconnects to a replaced Unix socket and detects malformed responses", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-reconnect-"));
  const socketPath = path.join(dataDir, "app-server.sock");
  const observer = new AppServerObserver({ discover: () => socketPath });
  let activeServer = null;
  try {
    activeServer = await startProtocolServer(socketPath, (webSocket, message) => respondToRead(webSocket, message));
    await observer.connect();
    const firstRead = await observer.readThreads(["thread-reconnect"]);
    assert.equal(firstRead[0].status.type, "active");

    await activeServer.close();
    activeServer = null;
    await waitFor(async () => observer.connected, (connected) => !connected);

    activeServer = await startProtocolServer(socketPath, (webSocket, message) => respondToRead(webSocket, message));
    await observer.connect();
    const secondRead = await observer.readThreads(["thread-reconnect"]);
    assert.equal(secondRead[0].status.type, "active");

    await activeServer.close();
    activeServer = null;
    await waitFor(async () => observer.connected, (connected) => !connected);
    activeServer = await startProtocolServer(socketPath, (webSocket, message) => {
      if (message.method === "initialize") respondToRead(webSocket, message);
      else if (message.method === "thread/read") webSocket.send("not-json");
    });
    await observer.connect();
    await assert.rejects(observer.readThreads(["thread-malformed"]), /malformed JSON/);

    await activeServer.close();
    activeServer = null;
    await waitFor(async () => observer.connected, (connected) => !connected);
    activeServer = await startProtocolServer(socketPath, (webSocket, message) => {
      if (message.method === "initialize") respondToRead(webSocket, message);
      else if (message.method === "thread/read") webSocket.send(JSON.stringify({ id: message.id, result: {} }));
    });
    await observer.connect();
    await assert.rejects(observer.readThreads(["thread-invalid-shape"]), /malformed thread\/read response/);
  } finally {
    observer.close();
    await activeServer?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed initialization closes the native transport before a retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-initialize-"));
  const socketPath = path.join(directory, "server.sock");
  let responding = false;
  const server = await startProtocolServer(socketPath, (socket, message) => {
    if (responding) respondToRead(socket, message);
  });
  const observer = new AppServerObserver({ discover: () => socketPath, requestTimeoutMs: 80 });
  try {
    await assert.rejects(observer.connect(), /initialize request timed out/);
    assert.equal(observer.connected, false);
    assert.equal(observer.socket, null);
    assert.equal(await waitFor(async () => server.clients.size, (count) => count === 0), 0);
    responding = true;
    await observer.connect();
    assert.equal((await observer.readThreads(["thread-retry"]))[0].status.type, "active");
  } finally {
    observer.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the observer accepts binary JSON responses from the native client", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-binary-"));
  const socketPath = path.join(directory, "server.sock");
  const server = await startProtocolServer(socketPath, (socket, message) => {
    if (message.method === "initialized") return;
    const result = message.method === "initialize"
      ? { serverInfo: { name: "fake-codex" } }
      : { thread: { id: message.params.threadId, status: { type: "idle" } } };
    socket.send(Buffer.from(JSON.stringify({ id: message.id, result })));
  });
  const observer = new AppServerObserver({ discover: () => socketPath });
  try {
    await observer.connect();
    assert.equal((await observer.readThreads(["thread-binary"]))[0].status.type, "idle");
  } finally {
    observer.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unobservable session uses hooks and reports unavailable automatic wait handling", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-no-daemon-"));
  const environment = {
    CODEX_KEEP_AWAKE_SOCKET: path.join(dataDir, "missing-app-server.sock"),
    CODEX_KEEP_AWAKE_TEST_PORTAL_DBUS_MODULE: path.join(repoRoot, "test", "helpers", "fake-portal-dbus.cjs"),
  };
  const threadId = "thread-without-daemon";
  try {
    const hook = await runCli(["hook"], dataDir, JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: threadId,
      turn_id: "turn-without-daemon",
      prompt: "do not store this",
    }), environment);
    assert.equal(hook.code, 0, hook.stderr);
    const degraded = await waitFor(
      () => readRuntimeState(dataDir),
      (state) => state?.runtime?.degradedReason === "app_server_unavailable",
    );
    assert.equal(degraded?.runtime?.protectionRequired, true);
    assert.equal(degraded?.runtime?.automaticPauseResume, false);
    assert.equal(typeof degraded?.runtime?.observationMessage, "string");

    const stop = await runCli(["hook"], dataDir, JSON.stringify({
      hook_event_name: "Stop",
      session_id: threadId,
      turn_id: "turn-without-daemon",
    }), environment);
    assert.equal(stop.code, 0, stop.stderr);
    const waiting = await waitFor(
      () => readRuntimeState(dataDir),
      (state) => state?.runtime?.protectionRequired === false,
    );
    assert.equal(waiting?.threads?.[threadId]?.waiting, "user_input");
    assert.equal(waiting?.runtime?.automaticPauseResume, false);
    assert.equal(JSON.stringify(waiting).includes("do not store this"), false);
  } finally {
    await runCli(["cleanup"], dataDir, "", environment).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
