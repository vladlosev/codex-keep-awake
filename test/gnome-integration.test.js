import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "scripts", "codex-keep-awake.js");
const reason = "Codex is running active work";
const holdMs = Number(process.env.CODEX_KEEP_AWAKE_GNOME_HOLD_MS ?? 0);

function run(file, args, { input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

async function createFakeAppServer(socketPath, statuses) {
  const server = createServer();
  const webSockets = new WebSocketServer({ server });
  webSockets.on("connection", (webSocket) => {
    webSocket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === "initialize") {
        webSocket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "test" } } }));
      } else if (message.method === "thread/read") {
        const status = statuses.get(message.params.threadId) ?? { type: "idle" };
        webSocket.send(JSON.stringify({
          id: message.id,
          result: { thread: { id: message.params.threadId, status } },
        }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    async close() {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => webSockets.close(resolve));
    },
  };
}

function inhibitorListing() {
  return execFileSync("gnome-session-inhibit", ["--list"], { encoding: "utf8" });
}

function codexInhibitorCount(listing) {
  return listing.split(/\r?\n/).filter((line) => line.includes(reason)).length;
}

async function waitFor(read, predicate, description, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("GNOME lease follows real D-Bus waits, concurrent threads, completion, and supervisor crashes", {
  skip: process.platform !== "linux",
}, async () => {
  const initialListing = inhibitorListing();
  assert.equal(codexInhibitorCount(initialListing), 0, "test requires no pre-existing Codex Keep Awake lease");

  const parent = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-gnome-"));
  const dataDir = path.join(parent, "plugin-data");
  const socketPath = path.join(parent, "app-server.sock");
  const statuses = new Map();
  let appServer;
  const baseEnv = { ...process.env };
  delete baseEnv.CODEX_KEEP_AWAKE_GNOME_INHIBITOR;
  const env = {
    ...baseEnv,
    PLUGIN_ROOT: root,
    PLUGIN_DATA: dataDir,
    CODEX_KEEP_AWAKE_SOCKET: socketPath,
  };

  const invokeHook = async (eventName, threadId) => {
    const result = await run(process.execPath, [cliPath, "hook", "--data-dir", dataDir], {
      env,
      input: JSON.stringify({ hook_event_name: eventName, session_id: threadId, turn_id: `turn-${threadId}` }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  };
  const readStatusAndInhibitors = async () => {
    const result = await run(process.execPath, [cliPath, "status", "--data-dir", dataDir], { env });
    assert.equal(result.code, 0, result.stderr);
    return { state: JSON.parse(result.stdout), listing: inhibitorListing() };
  };
  const waitForActiveLease = (description) => waitFor(
    readStatusAndInhibitors,
    ({ state, listing }) => state.runtime?.appServerConnected
      && state.runtime?.inhibitionActive
      && codexInhibitorCount(listing) === 1,
    description,
  );
  const waitForNoLease = (predicate, description) => waitFor(
    readStatusAndInhibitors,
    ({ state, listing }) => predicate(state) && codexInhibitorCount(listing) === 0,
    description,
  );

  try {
    await mkdir(dataDir);
    appServer = await createFakeAppServer(socketPath, statuses);

    statuses.set("thread-a", { type: "active", activeFlags: [] });
    await invokeHook("UserPromptSubmit", "thread-a");
    const firstActive = await waitForActiveLease("active work to create a GNOME inhibitor");
    const firstSupervisorPid = firstActive.state.supervisor.pid;
    assert.equal(firstActive.state.registeredThreads, 1);

    if (holdMs > 0) {
      const configuredTimeout = Number(execFileSync("gsettings", [
        "get", "org.gnome.settings-daemon.plugins.power", "sleep-inactive-ac-timeout",
      ], { encoding: "utf8" }).trim());
      assert.ok(Number.isFinite(configuredTimeout) && configuredTimeout > 0, "Automatic Suspend must have a finite positive AC timeout");
      assert.ok(holdMs > configuredTimeout * 1000, "requested active hold must exceed the configured Automatic Suspend timeout");
      const holdUntil = Date.now() + holdMs;
      while (Date.now() < holdUntil) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, holdUntil - Date.now())));
        const held = await readStatusAndInhibitors();
        assert.equal(held.state.runtime?.inhibitionActive, true, "GNOME lease must remain active during the full suspend-timeout hold");
        assert.equal(codexInhibitorCount(held.listing), 1, "GNOME must continue to list the inhibitor during the timeout hold");
        process.stdout.write(`GNOME inhibitor remains active (${Math.round((Date.now() - (holdUntil - holdMs)) / 1000)}s)\n`);
      }
    }

    statuses.set("thread-a", { type: "active", activeFlags: ["waitingOnApproval"] });
    const approvalWait = await waitForNoLease(
      (state) => state.runtime?.automaticPauseResume && state.threads[0]?.waiting === "approval",
      "approval wait to release the GNOME inhibitor",
    );
    assert.equal(approvalWait.state.runtime.protectionRequired, false);

    statuses.set("thread-a", { type: "active", activeFlags: [] });
    const resumed = await waitForActiveLease("resumed work to reacquire the GNOME inhibitor");
    assert.equal(resumed.state.supervisor.pid, firstSupervisorPid);

    statuses.set("thread-b", { type: "active", activeFlags: [] });
    await invokeHook("UserPromptSubmit", "thread-b");
    const concurrent = await waitForActiveLease("a concurrent thread to share the GNOME inhibitor");
    assert.equal(concurrent.state.registeredThreads, 2);
    assert.equal(concurrent.state.supervisor.pid, firstSupervisorPid);
    assert.equal(codexInhibitorCount(concurrent.listing), 1);

    statuses.set("thread-a", { type: "idle" });
    const secondThreadRemains = await waitFor(
      readStatusAndInhibitors,
      ({ state, listing }) => state.registeredThreads === 1
        && state.runtime?.inhibitionActive
        && codexInhibitorCount(listing) === 1,
      "the remaining active thread to retain the shared inhibitor",
    );
    assert.equal(secondThreadRemains.state.threads[0].threadId, "thread-b");

    statuses.set("thread-b", { type: "idle" });
    const completed = await waitForNoLease(
      (state) => state.registeredThreads === 0 && state.running === false,
      "completed threads to release the GNOME inhibitor",
    );
    assert.equal(completed.state.runtime, null);

    statuses.set("thread-crash", { type: "active", activeFlags: [] });
    await invokeHook("UserPromptSubmit", "thread-crash");
    const beforeCrash = await waitForActiveLease("crash-test work to acquire the GNOME inhibitor");
    process.kill(beforeCrash.state.supervisor.pid, "SIGKILL");
    const afterCrash = await waitForNoLease(
      (state) => state.running === false,
      "a killed supervisor to release its GNOME inhibitor child",
    );
    assert.equal(afterCrash.state.runtime?.degradedReason, "supervisor_not_running");
  } finally {
    try {
      await run(process.execPath, [cliPath, "cleanup", "--data-dir", dataDir], { env });
    } catch {}
    if (appServer) await appServer.close();
    await rm(parent, { recursive: true, force: true });
  }
});
