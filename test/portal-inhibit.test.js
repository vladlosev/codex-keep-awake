import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as backendModule from "../src/backend.js";
import { PORTAL_APP_ID } from "../src/portal-app-registration.js";

const portalName = "org.freedesktop.portal.Desktop";
const portalPath = "/org/freedesktop/portal/desktop";
const inhibitInterface = "org.freedesktop.portal.Inhibit";
const requestInterface = "org.freedesktop.portal.Request";
const registryInterface = "org.freedesktop.host.portal.Registry";
const propertiesInterface = "org.freedesktop.DBus.Properties";

class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

function fakeDbus({
  owner = ":1.77",
  initiallyOwned = true,
  onInhibit,
  registryVersion = 0,
  registryError,
  registerError,
} = {}) {
  const connection = new EventEmitter();
  connection.state = "connected";
  const calls = [];
  const callConnections = [];
  const sessionBusOptions = [];
  let ownerLookups = 0;
  const bus = {
    connection,
    name: null,
    async invokeDbus(message) {
      calls.push(message);
      callConnections.push(connection);
      if (message.member === "Hello") {
        bus.name = ":1.23";
        return bus.name;
      }
      if (message.member === "AddMatch") return undefined;
      if (message.member === "GetNameOwner") {
        ownerLookups += 1;
        if (!initiallyOwned && ownerLookups === 1) {
          throw Object.assign(new Error("private fake error"), {
            dbusName: "org.freedesktop.DBus.Error.NameHasNoOwner",
          });
        }
        return owner;
      }
      if (message.member === "StartServiceByName") return 1;
      throw new Error(`Unexpected bus call: ${message.member}`);
    },
    async invoke(message) {
      calls.push(message);
      callConnections.push(connection);
      if (message.interface === propertiesInterface && message.member === "Get") {
        if (registryError) throw registryError;
        assert.deepEqual(message.body, [registryInterface, "version"]);
        return new FakeVariant("u", registryVersion);
      }
      if (message.interface === registryInterface && message.member === "Register") {
        if (registerError) throw registerError;
        return undefined;
      }
      if (message.member === "Inhibit") return onInhibit?.(message, connection) ?? "/org/freedesktop/portal/desktop/request/_1_23/returned";
      if (message.member === "Close") return undefined;
      throw new Error(`Unexpected portal call: ${message.member}`);
    },
    async close() {
      bus.closed = true;
      connection.emit("close");
    },
  };
  return {
    calls,
    callConnections,
    bus,
    dbus: {
      Variant: FakeVariant,
      variantValue: (value) => value instanceof FakeVariant ? value.value : value,
      messageType: { signal: 4 },
      sessionBus(options) {
        sessionBusOptions.push(options);
        return bus;
      },
    },
    sessionBusOptions,
  };
}

function response(connection, { owner = ":1.77", path, code = 0 } = {}) {
  connection.emit("message", {
    type: 4,
    sender: owner,
    path,
    interface: requestInterface,
    member: "Response",
    signature: "ua{sv}",
    body: [code, {}],
  });
}

test("portal acquisition requests suspend only and accepts an early response on the returned handle", async () => {
  assert.equal(typeof backendModule.acquirePortalInhibitor, "function");
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    onInhibit(message, connection) {
      response(connection, { owner: ":1.88", path: requestPath });
      response(connection, { path: requestPath });
      return requestPath;
    },
  });

  const lease = await backendModule.acquirePortalInhibitor({
    dbus: fake.dbus,
    reason: "OpenCode is running active work",
    environment: {},
  });
  const inhibit = fake.calls.find((call) => call.member === "Inhibit");

  assert.equal(inhibit.destination, portalName);
  assert.equal(inhibit.path, portalPath);
  assert.equal(inhibit.interface, inhibitInterface);
  assert.equal(inhibit.signature, "sua{sv}");
  assert.equal(inhibit.body[0], "");
  assert.equal(inhibit.body[1], 4);
  assert.deepEqual(Object.keys(inhibit.body[2]).sort(), ["handle_token", "reason"]);
  assert.equal(inhibit.body[2].handle_token.signature, "s");
  assert.match(inhibit.body[2].handle_token.value, /^[a-zA-Z0-9_]+$/);
  assert.deepEqual(inhibit.body[2].reason, new FakeVariant("s", "OpenCode is running active work"));
  assert.equal(fake.sessionBusOptions[0].direct, true);
  assert.equal(lease.requestPath, requestPath);

  await lease.release();
  await lease.release();
  const closeCalls = fake.calls.filter((call) => call.member === "Close");
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].destination, portalName);
  assert.equal(closeCalls[0].path, requestPath);
  assert.equal(fake.bus.closed, true);
});

test("portal activation is requested when the service has no current owner", async () => {
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    initiallyOwned: false,
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      return requestPath;
    },
  });

  const lease = await backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work", environment: {} });
  assert.ok(fake.calls.some((call) => call.member === "StartServiceByName"));
  await lease.release();
});

test("unsuccessful portal responses close the request and session bus", async () => {
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    onInhibit(message, connection) {
      response(connection, { path: requestPath, code: 2 });
      return requestPath;
    },
  });

  await assert.rejects(
    backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work", environment: {} }),
    { code: "PORTAL_REJECTED" },
  );
  assert.ok(fake.calls.some((call) => call.member === "Close" && call.path === requestPath));
  assert.equal(fake.bus.closed, true);
});

test("portal acquisition deadline covers a missing Response signal", async () => {
  const fake = fakeDbus({ onInhibit: () => `${portalPath}/request/_1_23/returned` });

  await assert.rejects(
    backendModule.acquirePortalInhibitor({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      timeoutMs: 15,
      environment: {},
    }),
    { code: "PORTAL_TIMEOUT" },
  );
  assert.equal(fake.bus.closed, true);
});

test("cancellation during an outstanding portal method call closes the bus", async () => {
  const controller = new AbortController();
  const fake = fakeDbus({ onInhibit: () => new Promise(() => {}) });
  const acquiring = backendModule.acquirePortalInhibitor({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    signal: controller.signal,
    environment: {},
  });
  const cancel = setTimeout(() => controller.abort(), 10);

  try {
    await assert.rejects(acquiring, { code: "PORTAL_CANCELLED" });
  } finally {
    clearTimeout(cancel);
  }
  assert.equal(fake.bus.closed, true);
});

test("cancellation racing a successful Response closes the late request", async () => {
  const controller = new AbortController();
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      controller.abort();
      return requestPath;
    },
  });

  await assert.rejects(
    backendModule.acquirePortalInhibitor({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      signal: controller.signal,
      environment: {},
    }),
    { code: "PORTAL_CANCELLED" },
  );
  assert.ok(fake.calls.some((call) => call.member === "Close" && call.path === requestPath));
  assert.equal(fake.bus.closed, true);
});

test("portal owner changes invalidate a live lease", async () => {
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      return requestPath;
    },
  });
  const lease = await backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work", environment: {} });
  fake.bus.connection.emit("message", {
    type: 4,
    sender: "org.freedesktop.DBus",
    interface: "org.freedesktop.DBus",
    member: "NameOwnerChanged",
    signature: "sss",
    body: [portalName, ":1.77", ":1.78"],
  });

  await assert.rejects(lease.lost, { code: "PORTAL_OWNER_CHANGED" });
  await lease.release();
  assert.equal(fake.calls.filter((call) => call.member === "Close").length, 0);
  assert.equal(fake.bus.closed, true);
});

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "keep-awake-portal-registration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("MATE app identity is registered before Inhibit on the same D-Bus connection", async (t) => {
  const dataHome = temporaryDirectory(t);
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    registryVersion: 1,
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      return requestPath;
    },
  });
  const environment = { XDG_CURRENT_DESKTOP: "MATE", XDG_DATA_HOME: dataHome, HOME: dataHome };

  const lease = await backendModule.acquirePortalInhibitor({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    platform: "linux",
    environment,
  });
  const registrationIndex = fake.calls.findIndex((call) => call.interface === registryInterface && call.member === "Register");
  const inhibitIndex = fake.calls.findIndex((call) => call.member === "Inhibit");
  const registration = fake.calls[registrationIndex];
  const inhibit = fake.calls[inhibitIndex];
  const desktopFilePath = path.join(dataHome, "applications", `${PORTAL_APP_ID}.desktop`);

  assert.ok(registrationIndex >= 0);
  assert.ok(registrationIndex < inhibitIndex);
  assert.equal(registration.destination, portalName);
  assert.equal(registration.path, portalPath);
  assert.equal(registration.signature, "sa{sv}");
  assert.deepEqual(registration.body, [PORTAL_APP_ID, {}]);
  assert.equal(fake.callConnections[registrationIndex], fake.bus.connection);
  assert.equal(fake.callConnections[inhibitIndex], fake.callConnections[registrationIndex]);
  assert.ok(existsSync(desktopFilePath));
  assert.match(readFileSync(desktopFilePath, "utf8"), /^NoDisplay=true$/m);

  await lease.release();
});

test("GNOME skips Registry and desktop-file creation", async (t) => {
  const dataHome = temporaryDirectory(t);
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    registryVersion: 1,
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      return requestPath;
    },
  });

  const lease = await backendModule.acquirePortalInhibitor({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    platform: "linux",
    environment: { XDG_CURRENT_DESKTOP: "GNOME", XDG_DATA_HOME: dataHome, HOME: dataHome },
  });

  assert.equal(fake.calls.some((call) => call.interface === propertiesInterface && call.member === "Get"), false);
  assert.equal(fake.calls.some((call) => call.member === "Register"), false);
  assert.equal(existsSync(path.join(dataHome, "applications")), false);
  assert.ok(fake.calls.some((call) => call.member === "Inhibit"));
  await lease.release();
});

test("Registry version zero or an unsupported Registry interface falls back without a desktop entry", async (t) => {
  for (const registry of [
    { registryVersion: 0 },
    { registryError: Object.assign(new Error("private fake error"), { dbusName: "org.freedesktop.DBus.Error.UnknownInterface" }) },
  ]) {
    const dataHome = temporaryDirectory(t);
    const requestPath = `${portalPath}/request/_1_23/returned`;
    const fake = fakeDbus({
      ...registry,
      onInhibit(message, connection) {
        response(connection, { path: requestPath });
        return requestPath;
      },
    });
    const lease = await backendModule.acquirePortalInhibitor({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "MATE", XDG_DATA_HOME: dataHome, HOME: dataHome },
    });

    assert.equal(fake.calls.some((call) => call.member === "Register"), false);
    assert.equal(existsSync(path.join(dataHome, "applications")), false);
    assert.ok(fake.calls.some((call) => call.member === "Inhibit"));
    await lease.release();
  }
});

test("Registry registration failure is sanitized and does not fall through to Inhibit", async (t) => {
  const dataHome = temporaryDirectory(t);
  const fake = fakeDbus({
    registryVersion: 1,
    registerError: Object.assign(new Error("sensitive bus detail"), { dbusName: "org.freedesktop.DBus.Error.AccessDenied" }),
  });

  await assert.rejects(
    backendModule.acquirePortalInhibitor({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "MATE", XDG_DATA_HOME: dataHome, HOME: dataHome },
      timeoutMs: 50,
    }),
    {
      code: "PORTAL_APP_REGISTRATION_FAILED",
      message: "The XDG Desktop Portal rejected the Codex Keep Awake app identity",
    },
  );
  assert.equal(fake.calls.some((call) => call.member === "Inhibit"), false);
  assert.equal(fake.bus.closed, true);
});

test("desktop-entry preparation failure is sanitized and closes the bus", async (t) => {
  const dataHome = temporaryDirectory(t);
  const applications = path.join(dataHome, "applications");
  mkdirSync(applications);
  writeFileSync(path.join(applications, `${PORTAL_APP_ID}.desktop`), "[Desktop Entry]\nName=User application\n");
  const fake = fakeDbus({ registryVersion: 1 });

  await assert.rejects(
    backendModule.acquirePortalInhibitor({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "MATE", XDG_DATA_HOME: dataHome, HOME: dataHome },
      timeoutMs: 50,
    }),
    {
      code: "PORTAL_DESKTOP_ENTRY_FAILED",
      message: "The Codex Keep Awake desktop identity entry could not be prepared",
    },
  );
  assert.equal(fake.calls.some((call) => call.member === "Register" || call.member === "Inhibit"), false);
  assert.equal(fake.bus.closed, true);
});

test("Portal backend forwards its injected environment to portal acquisition", async (t) => {
  const dataHome = temporaryDirectory(t);
  const requestPath = `${portalPath}/request/_1_23/returned`;
  const fake = fakeDbus({
    registryVersion: 1,
    onInhibit(message, connection) {
      response(connection, { path: requestPath });
      return requestPath;
    },
  });
  const backend = new backendModule.PortalInhibitorBackend({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    platform: "linux",
    environment: { XDG_CURRENT_DESKTOP: "MATE", XDG_DATA_HOME: dataHome, HOME: dataHome },
  });
  const active = new Promise((resolve) => {
    const unsubscribe = backend.subscribeStatus((status) => {
      if (!status.active) return;
      unsubscribe();
      resolve();
    });
  });

  backend.setRequired(true);
  await active;
  assert.ok(fake.calls.some((call) => call.member === "Register"));
  await backend.close();
});
