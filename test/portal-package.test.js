import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const supported = process.platform === "linux"
  && spawnSync("dbus-daemon", ["--version"], { encoding: "utf8" }).status === 0;

function waitForLine(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Process exited (${code}) before ${expected}`));
    const onLine = (line) => {
      if (line === expected) finish();
    };
    function finish(error) {
      clearTimeout(timer);
      lines.removeListener("line", onLine);
      lines.close();
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    lines.on("line", onLine);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForClose(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for process exit")), timeoutMs);
    const onClose = () => finish();
    function finish(error) {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    child.once("close", onClose);
  });
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function logEvents(logPath) {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("packed Linux backend owns the portal request directly and releases it on cleanup or host crash", {
  skip: !supported,
}, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "keep-awake-portal-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const consumer = path.join(directory, "consumer");
  mkdirSync(consumer);
  const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  const packedResults = JSON.parse(packed.stdout);
  const [{ filename }] = Array.isArray(packedResults) ? packedResults : Object.values(packedResults);
  const archive = path.join(directory, filename);
  const installed = spawnSync("npm", [
    "install", "--offline", "--ignore-scripts", "--omit=dev", "--omit=optional",
    "--no-audit", "--no-fund", "--package-lock=false", archive,
  ], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message);
  const packageRoot = path.join(consumer, "node_modules", "codex-keep-awake");
  const probePath = path.join(consumer, "portal-backend-probe.mjs");
  writeFileSync(probePath, `
    import { PortalInhibitorBackend } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "src", "backend.js")).href)};

    const backend = new PortalInhibitorBackend({ reason: process.argv[2] });
    const acquired = Promise.withResolvers();
    let unsubscribe;
    const timeout = setTimeout(() => acquired.reject(new Error("Portal acquisition timed out")), 5000);
    unsubscribe = backend.subscribeStatus((status) => {
      if (!status.active) return;
      clearTimeout(timeout);
      unsubscribe();
      acquired.resolve();
    });
    backend.setRequired(true);
    await acquired.promise;
    process.stdout.write("PORTAL_BACKEND_ACTIVE\\n");
    await new Promise((resolve) => {
      process.stdin.once("end", resolve);
      process.stdin.resume();
    });
    await backend.close();
  `);

  const daemon = spawn("dbus-daemon", [
    "--session", "--nofork", "--nopidfile", "--print-address=1", "--print-pid=1",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let daemonStderr = "";
  daemon.stderr.setEncoding("utf8").on("data", (chunk) => { daemonStderr += chunk; });
  const daemonLines = createInterface({ input: daemon.stdout });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out starting private D-Bus")), 5000);
    daemonLines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    daemon.once("error", reject);
    daemon.once("exit", (code) => reject(new Error(`Private D-Bus exited (${code}): ${daemonStderr}`)));
  });
  t.after(() => {
    daemon.kill("SIGTERM");
    daemonLines.close();
  });

  const logPath = path.join(directory, "portal-events.jsonl");
  const dbusEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address };
  const service = spawn(process.execPath, [path.join(root, "test", "helpers", "fake-portal-service.cjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...dbusEnv, CODEX_KEEP_AWAKE_TEST_PORTAL_LOG: logPath },
  });
  let serviceStderr = "";
  service.stderr.setEncoding("utf8").on("data", (chunk) => { serviceStderr += chunk; });
  t.after(async () => {
    if (service.exitCode === null) service.kill("SIGTERM");
    await waitForClose(service).catch(() => {});
  });
  await waitForLine(service, "FAKE_PORTAL_READY");

  const host = spawn(process.execPath, [probePath, "Packed portal backend test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: dbusEnv,
  });
  let hostStderr = "";
  host.stderr.setEncoding("utf8").on("data", (chunk) => { hostStderr += chunk; });
  t.after(async () => {
    if (host.exitCode === null) host.kill("SIGKILL");
    await waitForClose(host).catch(() => {});
  });
  await waitForLine(host, "PORTAL_BACKEND_ACTIVE");
  const acquired = await waitFor(() => logEvents(logPath).find((event) => event.type === "inhibit"), "portal Inhibit call");
  assert.equal(acquired.flags, 4);
  assert.equal(acquired.reason, "Packed portal backend test");
  assert.ok(acquired.path.endsWith(`/${acquired.token}`));
  assert.equal(host.exitCode, null, "the host process must keep its D-Bus request alive");

  host.stdin.end();
  await waitForClose(host);
  assert.equal(host.exitCode, 0, hostStderr);
  const closed = await waitFor(() => logEvents(logPath).find((event) => event.type === "close"), "Request.Close");
  assert.equal(closed.path, acquired.path);

  const crashedHost = spawn(process.execPath, [probePath, "Portal host crash test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: dbusEnv,
  });
  t.after(async () => {
    if (crashedHost.exitCode === null) crashedHost.kill("SIGKILL");
    await waitForClose(crashedHost).catch(() => {});
  });
  await waitForLine(crashedHost, "PORTAL_BACKEND_ACTIVE");
  const crashRequest = await waitFor(
    () => logEvents(logPath).find((event) => event.type === "inhibit" && event.reason === "Portal host crash test"),
    "second portal Inhibit call",
  );
  crashedHost.kill("SIGKILL");
  await waitForClose(crashedHost);
  const disconnected = await waitFor(
    () => logEvents(logPath).find((event) => event.type === "disconnect" && event.path === crashRequest.path),
    "portal-side request cleanup after host crash",
  );
  assert.equal(disconnected.sender, crashRequest.sender);
  assert.equal(service.exitCode, null, serviceStderr);
});
