import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const services = [];
  const startService = async (registryVersion) => {
    const record = { child: null, stderr: "" };
    record.child = spawn(process.execPath, [path.join(root, "test", "helpers", "fake-portal-service.cjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...dbusEnv,
        CODEX_KEEP_AWAKE_TEST_PORTAL_LOG: logPath,
        CODEX_KEEP_AWAKE_TEST_REGISTRY_VERSION: registryVersion,
      },
    });
    record.child.stderr.setEncoding("utf8").on("data", (chunk) => { record.stderr += chunk; });
    services.push(record);
    await waitForLine(record.child, "FAKE_PORTAL_READY");
    return record;
  };
  const stopService = async (record) => {
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill("SIGTERM");
    await waitForClose(record.child).catch(() => {});
  };
  t.after(async () => {
    await Promise.all(services.map(stopService));
  });
  let service = await startService("1");

  const registeredDataHome = path.join(directory, "registered-xdg-data");
  const hostEnv = {
    ...dbusEnv,
    HOME: path.join(directory, "home"),
    XDG_DATA_HOME: registeredDataHome,
    XDG_CURRENT_DESKTOP: "MATE",
    XDG_SESSION_DESKTOP: "",
  };
  const host = spawn(process.execPath, [probePath, "Packed portal backend test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: hostEnv,
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
  const eventsAfterAcquire = logEvents(logPath);
  const registered = eventsAfterAcquire.find((event) => event.type === "register" && event.sender === acquired.sender);
  assert.deepEqual(registered, {
    type: "register",
    appId: "io.github.vladlosev.CodexKeepAwake",
    options: {},
    sender: acquired.sender,
  });
  const registrationEventIndex = eventsAfterAcquire.findIndex((event) => event.type === "register" && event.sender === acquired.sender);
  const inhibitEventIndex = eventsAfterAcquire.findIndex((event) => event.type === "inhibit" && event.sender === acquired.sender);
  assert.ok(registrationEventIndex < inhibitEventIndex);
  const desktopEntry = readFileSync(path.join(registeredDataHome, "applications", "io.github.vladlosev.CodexKeepAwake.desktop"), "utf8");
  assert.match(desktopEntry, /^Type=Application$/m);
  assert.match(desktopEntry, /^Name=Codex Keep Awake Extension$/m);
  assert.match(desktopEntry, /^Terminal=true$/m);
  assert.match(desktopEntry, /^NoDisplay=true$/m);
  assert.match(desktopEntry, /^X-Codex-Keep-Awake-Generated=true$/m);
  assert.equal(host.exitCode, null, "the host process must keep its D-Bus request alive");

  host.stdin.end();
  await waitForClose(host);
  assert.equal(host.exitCode, 0, hostStderr);
  const closed = await waitFor(() => logEvents(logPath).find((event) => event.type === "close"), "Request.Close");
  assert.equal(closed.path, acquired.path);

  const crashedHost = spawn(process.execPath, [probePath, "Portal host crash test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: hostEnv,
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
  assert.equal(service.child.exitCode, null, service.stderr);

  const gnomeDataHome = path.join(directory, "gnome-xdg-data");
  const gnomeHost = spawn(process.execPath, [probePath, "Packed GNOME fallback test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...dbusEnv,
      HOME: path.join(directory, "gnome-home"),
      XDG_DATA_HOME: gnomeDataHome,
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_DESKTOP: "",
    },
  });
  t.after(async () => {
    if (gnomeHost.exitCode === null) gnomeHost.kill("SIGKILL");
    await waitForClose(gnomeHost).catch(() => {});
  });
  await waitForLine(gnomeHost, "PORTAL_BACKEND_ACTIVE");
  const gnomeRequest = await waitFor(
    () => logEvents(logPath).find((event) => event.type === "inhibit" && event.reason === "Packed GNOME fallback test"),
    "GNOME fallback Inhibit call",
  );
  assert.equal(logEvents(logPath).some((event) => event.type === "register" && event.sender === gnomeRequest.sender), false);
  assert.equal(existsSync(path.join(gnomeDataHome, "applications")), false);
  gnomeHost.stdin.end();
  await waitForClose(gnomeHost);
  assert.equal(gnomeHost.exitCode, 0);

  await stopService(service);
  service = await startService("none");
  const unsupportedDataHome = path.join(directory, "unsupported-xdg-data");
  const unsupportedHost = spawn(process.execPath, [probePath, "Packed MATE Registry fallback test"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...dbusEnv,
      HOME: path.join(directory, "unsupported-home"),
      XDG_DATA_HOME: unsupportedDataHome,
      XDG_CURRENT_DESKTOP: "MATE",
      XDG_SESSION_DESKTOP: "",
    },
  });
  t.after(async () => {
    if (unsupportedHost.exitCode === null) unsupportedHost.kill("SIGKILL");
    await waitForClose(unsupportedHost).catch(() => {});
  });
  await waitForLine(unsupportedHost, "PORTAL_BACKEND_ACTIVE");
  const unsupportedRequest = await waitFor(
    () => logEvents(logPath).find((event) => event.type === "inhibit" && event.reason === "Packed MATE Registry fallback test"),
    "MATE fallback Inhibit call",
  );
  assert.equal(logEvents(logPath).some((event) => event.type === "register" && event.sender === unsupportedRequest.sender), false);
  assert.equal(existsSync(path.join(unsupportedDataHome, "applications")), false);
  unsupportedHost.stdin.end();
  await waitForClose(unsupportedHost);
  assert.equal(unsupportedHost.exitCode, 0);
});
