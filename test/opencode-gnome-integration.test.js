import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import OpenCodeKeepAwake from "../.opencode/plugins/codex-keep-awake.js";

const reason = "OpenCode is running active work";

function inhibitorCount() {
  const listing = execFileSync("gnome-session-inhibit", ["--list"], { encoding: "utf8" });
  return listing.split(/\r?\n/).filter((line) => line.includes(reason)).length;
}

async function waitForCount(expected, description, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = inhibitorCount();
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(inhibitorCount(), expected, `timed out waiting for ${description}`);
}

function send(hooks, type, properties) {
  hooks.event({ event: { type, properties } });
}

test("OpenCode plugin follows busy, permission wait, resumed work, and idle in GNOME", {
  skip: process.platform !== "linux",
}, async () => {
  assert.equal(inhibitorCount(), 0, "test requires no pre-existing OpenCode Keep Awake lease");
  const hooks = await OpenCodeKeepAwake.server({});

  try {
    send(hooks, "session.created", { info: { id: "integration-session" } });
    send(hooks, "session.status", {
      sessionID: "integration-session",
      status: { type: "busy" },
    });
    await waitForCount(1, "busy work to acquire a GNOME inhibitor");

    send(hooks, "permission.asked", { id: "permission-1", sessionID: "integration-session" });
    await waitForCount(0, "a permission wait to release the GNOME inhibitor");

    send(hooks, "permission.replied", {
      requestID: "permission-1",
      sessionID: "integration-session",
      reply: "once",
    });
    await waitForCount(1, "resumed work to reacquire a GNOME inhibitor");

    send(hooks, "session.status", {
      sessionID: "integration-session",
      status: { type: "idle" },
    });
    await waitForCount(0, "idle work to release the GNOME inhibitor");
  } finally {
    hooks.dispose();
    await waitForCount(0, "plugin disposal to release the GNOME inhibitor");
  }
});
