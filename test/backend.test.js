import assert from "node:assert/strict";
import test from "node:test";
import { PortalInhibitorBackend } from "../src/backend.js";
import { portalClient, reconnectingPortalClient, waitFor } from "./helpers/fake-portal-client.js";

test("portal backend owns the D-Bus lease in-process until protection is no longer required", async () => {
  const fake = portalClient();
  const backend = new PortalInhibitorBackend({
    dbus: fake.dbus,
    reason: "OpenCode is running active work",
  });

  backend.setRequired(true);
  await waitFor(() => fake.calls.some((call) => call.member === "Inhibit"));
  assert.equal(backend.status().active, false, "the portal response is the acquisition boundary");
  fake.respond();
  await waitFor(() => backend.status().active);

  const inhibit = fake.calls.find((call) => call.member === "Inhibit");
  assert.equal(inhibit.body[2].reason.value, "OpenCode is running active work");
  assert.equal(backend.status().required, true);

  backend.setRequired(false);
  await waitFor(() => fake.bus.closed);
  assert.equal(fake.calls.filter((call) => call.member === "Close").length, 1);
  assert.deepEqual(backend.status(), {
    required: false,
    active: false,
    error: null,
    command: null,
  });
  await backend.close();
});

test("portal backend retries a rejected request while work remains active", async () => {
  const fake = reconnectingPortalClient();
  const backend = new PortalInhibitorBackend({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    retryDelayMs: 10,
  });

  backend.setRequired(true);
  await waitFor(() => fake.clients[0]?.calls.some((call) => call.member === "Inhibit"));
  fake.clients[0].respond(2);
  await waitFor(() => backend.status().error !== null);
  assert.equal(backend.status().required, true);
  assert.equal(backend.status().active, false);

  await waitFor(() => fake.clients[1]?.calls.some((call) => call.member === "Inhibit"));
  fake.clients[1].respond();
  await waitFor(() => backend.status().active);
  await backend.close();
});

test("portal backend reacquires inhibition after the portal owner changes", async () => {
  const fake = reconnectingPortalClient();
  const backend = new PortalInhibitorBackend({
    dbus: fake.dbus,
    reason: "Codex is running active work",
    retryDelayMs: 10,
  });

  backend.setRequired(true);
  await waitFor(() => fake.clients[0]?.calls.some((call) => call.member === "Inhibit"));
  fake.clients[0].respond();
  await waitFor(() => backend.status().active);
  fake.clients[0].changeOwner();
  await waitFor(() => !backend.status().active && backend.status().error !== null);

  await waitFor(() => fake.clients[1]?.calls.some((call) => call.member === "Inhibit"));
  fake.clients[1].respond();
  await waitFor(() => backend.status().active);
  await backend.close();
});

for (const event of ["close", "error"]) {
  test(`portal backend reacquires inhibition after a D-Bus connection ${event}`, async () => {
    const fake = reconnectingPortalClient();
    const backend = new PortalInhibitorBackend({
      dbus: fake.dbus,
      reason: "Codex is running active work",
      retryDelayMs: 10,
    });

    backend.setRequired(true);
    await waitFor(() => fake.clients[0]?.calls.some((call) => call.member === "Inhibit"));
    fake.clients[0].respond();
    await waitFor(() => backend.status().active);
    fake.clients[0].disconnect(event);
    await waitFor(() => !backend.status().active && backend.status().error !== null);

    await waitFor(() => fake.clients[1]?.calls.some((call) => call.member === "Inhibit"));
    fake.clients[1].respond();
    await waitFor(() => backend.status().active);
    await backend.close();
  });
}

test("portal backend cancels an in-flight request and releases its connection when work pauses", async () => {
  const fake = portalClient({ pendingInhibit: true });
  const backend = new PortalInhibitorBackend({
    dbus: fake.dbus,
    reason: "Codex is running active work",
  });

  backend.setRequired(true);
  await waitFor(() => fake.calls.some((call) => call.member === "Inhibit"));
  backend.setRequired(false);
  await waitFor(() => fake.bus.closed);
  assert.equal(backend.status().active, false);
  assert.equal(backend.status().required, false);
  assert.equal(fake.calls.some((call) => call.member === "Close"), false);
  await backend.close();
});

test("portal backend reports unsupported platforms without opening a D-Bus connection", async () => {
  const backend = new PortalInhibitorBackend({
    platform: "win32",
    reason: "Codex is running active work",
  });

  backend.setRequired(true);
  assert.deepEqual(backend.status(), {
    required: true,
    active: false,
    error: "The XDG Desktop Portal suspend inhibitor is only available on Linux",
    command: null,
  });
  await backend.close();
});
