import { EventEmitter } from "node:events";

export class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

export function portalClient({ pendingInhibit = false } = {}) {
  const requestPath = "/org/freedesktop/portal/desktop/request/_1_23/keep_awake";
  const connection = new EventEmitter();
  connection.state = "connected";
  const calls = [];
  const bus = {
    connection,
    async invokeDbus(message) {
      calls.push(message);
      if (message.member === "Hello") return ":1.23";
      if (message.member === "AddMatch") return undefined;
      if (message.member === "GetNameOwner") return ":1.77";
      throw new Error(`Unexpected bus call: ${message.member}`);
    },
    async invoke(message, { signal } = {}) {
      calls.push(message);
      if (message.member === "Inhibit") {
        if (pendingInhibit) {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return requestPath;
      }
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
    connection,
    dbus: {
      Variant: FakeVariant,
      messageType: { signal: 4 },
      sessionBus: () => bus,
    },
    respond(code = 0) {
      connection.emit("message", {
        type: 4,
        sender: ":1.77",
        path: requestPath,
        interface: "org.freedesktop.portal.Request",
        member: "Response",
        signature: "ua{sv}",
        body: [code, {}],
      });
    },
    changeOwner() {
      connection.emit("message", {
        type: 4,
        sender: "org.freedesktop.DBus",
        interface: "org.freedesktop.DBus",
        member: "NameOwnerChanged",
        signature: "sss",
        body: ["org.freedesktop.portal.Desktop", ":1.77", ":1.78"],
      });
    },
    disconnect(event = "close") {
      connection.emit(event, ...(event === "error" ? [new Error("private fake connection error")] : []));
    },
  };
}

export function reconnectingPortalClient() {
  const clients = [];
  return {
    clients,
    dbus: {
      Variant: FakeVariant,
      messageType: { signal: 4 },
      sessionBus() {
        const client = portalClient();
        clients.push(client);
        return client.bus;
      },
    },
  };
}

export async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the fake portal");
}
