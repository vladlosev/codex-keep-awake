import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as backendModule from "../src/backend.js";

const portalName = "org.freedesktop.portal.Desktop";
const portalPath = "/org/freedesktop/portal/desktop";
const inhibitInterface = "org.freedesktop.portal.Inhibit";
const requestInterface = "org.freedesktop.portal.Request";

class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

function fakeDbus({ owner = ":1.77", initiallyOwned = true, onInhibit } = {}) {
  const connection = new EventEmitter();
  connection.state = "connected";
  const calls = [];
  const sessionBusOptions = [];
  let ownerLookups = 0;
  const bus = {
    connection,
    name: null,
    async invokeDbus(message) {
      calls.push(message);
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
    bus,
    dbus: {
      Variant: FakeVariant,
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

  const lease = await backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work" });
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
    backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work" }),
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
  const lease = await backendModule.acquirePortalInhibitor({ dbus: fake.dbus, reason: "Codex is running active work" });
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
