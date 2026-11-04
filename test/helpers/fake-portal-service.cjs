"use strict";

const dbus = require("dbus-native");
const { appendFileSync } = require("node:fs");

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const REGISTRY_INTERFACE = "org.freedesktop.host.portal.Registry";
const logPath = process.env.CODEX_KEEP_AWAKE_TEST_PORTAL_LOG;
const registrySetting = process.env.CODEX_KEEP_AWAKE_TEST_REGISTRY_VERSION ?? "0";
const registryVersion = Number.parseInt(registrySetting, 10);
const bus = dbus.sessionBus({ timeout: 5000 });
const requests = new Map();

function record(event) {
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function unvariant(value) {
  return dbus.variantValue(value);
}

const portal = dbus.defineInterface({
  name: "org.freedesktop.portal.Inhibit",
  methods: {
    Inhibit: {
      in: { window: "s", flags: "u", options: "a{sv}" },
      out: { handle: "o" },
      async handler({ window, flags, options }, { sender }) {
        const token = unvariant(options.handle_token);
        const reason = unvariant(options.reason);
        const senderPart = sender.slice(1).replaceAll(".", "_");
        const requestPath = `${PORTAL_PATH}/request/${senderPart}/${token}`;
        const request = dbus.defineInterface({
          name: "org.freedesktop.portal.Request",
          methods: {
            Close: {
              in: {},
              out: {},
              handler() {
                record({ type: "close", path: requestPath, sender });
                requests.delete(sender);
              },
            },
          },
          signals: {
            Response: { args: { response: "u", results: "a{sv}" } },
          },
        });
        await bus.export(requestPath, request);
        requests.set(sender, requestPath);
        record({ type: "inhibit", window, flags, token, reason, path: requestPath, sender });
        setTimeout(() => request.emit.Response(0, {}), 5);
        return requestPath;
      },
    },
  },
});

const registry = registrySetting === "none" ? null : dbus.defineInterface({
  name: REGISTRY_INTERFACE,
  properties: {
    version: { type: "u", access: "read", value: Number.isInteger(registryVersion) ? registryVersion : 0 },
  },
  methods: {
    Register: {
      in: { app_id: "s", options: "a{sv}" },
      out: {},
      handler({ app_id, options }, { sender }) {
        record({ type: "register", appId: app_id, options, sender });
      },
    },
  },
});

async function start() {
  const nameResult = await bus.requestName(PORTAL_NAME, 0);
  if (nameResult !== 1 && nameResult !== 4) throw new Error("Could not own the fake portal name");
  await bus.export(PORTAL_PATH, portal);
  if (registry) await bus.export(PORTAL_PATH, registry);
  await bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'");
  bus.connection.on("message", (message) => {
    if (message.interface !== "org.freedesktop.DBus"
      || message.member !== "NameOwnerChanged"
      || !Array.isArray(message.body)) return;
    const [name, oldOwner, newOwner] = message.body;
    if (requests.has(name) && oldOwner && !newOwner) {
      const requestPath = requests.get(name);
      requests.delete(name);
      record({ type: "disconnect", path: requestPath, sender: name });
    }
  });
  process.stdout.write("FAKE_PORTAL_READY\n");
}

async function stop() {
  await bus.close();
}

process.once("SIGTERM", () => { void stop().finally(() => { process.exitCode = 0; }); });
process.once("SIGINT", () => { void stop().finally(() => { process.exitCode = 0; }); });
start().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
