"use strict";

const { EventEmitter } = require("node:events");
const { unlinkSync, writeFileSync } = require("node:fs");

const markerPath = process.env.CODEX_KEEP_AWAKE_TEST_PORTAL_MARKER;
const reasonPath = process.env.CODEX_KEEP_AWAKE_TEST_PORTAL_REASON_FILE;
const pidPath = process.env.CODEX_KEEP_AWAKE_TEST_PORTAL_PID_FILE;
const portalPath = "/org/freedesktop/portal/desktop";

class Variant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

function removeMarker() {
  if (markerPath) {
    try {
      unlinkSync(markerPath);
    } catch {}
  }
}

module.exports = {
  Variant,
  messageType: { signal: 4 },
  sessionBus() {
    const connection = new EventEmitter();
    connection.state = "connected";
    const calls = [];
    const requestPath = `${portalPath}/request/_1_23/codex_keep_awake_test`;
    let closed = false;
    let responseTimer;
    const bus = {
      connection,
      async invokeDbus(message) {
        calls.push(message);
        if (message.member === "Hello") return ":1.23";
        if (message.member === "AddMatch") return undefined;
        if (message.member === "GetNameOwner") return ":1.77";
        throw new Error(`Unexpected fake D-Bus call: ${message.member}`);
      },
      async invoke(message) {
        calls.push(message);
        if (message.member === "Inhibit") {
          const reason = message.body[2].reason.value;
          if (reasonPath) writeFileSync(reasonPath, `${reason}\n`, { mode: 0o600 });
          if (pidPath) writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
          responseTimer = setTimeout(() => {
            if (closed) return;
            if (markerPath) writeFileSync(markerPath, "held\n", { mode: 0o600 });
            connection.emit("message", {
              type: 4,
              sender: ":1.77",
              path: requestPath,
              interface: "org.freedesktop.portal.Request",
              member: "Response",
              signature: "ua{sv}",
              body: [0, {}],
            });
          }, 5);
          return requestPath;
        }
        if (message.member === "Close") {
          if (responseTimer) clearTimeout(responseTimer);
          removeMarker();
          return undefined;
        }
        throw new Error(`Unexpected fake portal call: ${message.member}`);
      },
      async close() {
        if (closed) return;
        closed = true;
        if (responseTimer) clearTimeout(responseTimer);
        removeMarker();
        connection.emit("close");
      },
    };
    return bus;
  },
};
