import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import OpenCodeKeepAwake from "../.opencode/plugins/codex-keep-awake.js";
import { controlledEvents, v2Event } from "./helpers/opencode.js";

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

for (const version of ["V1", "V2"]) test(`OpenCode ${version} follows work, waits and cleanup in GNOME`, {
  skip: process.platform !== "linux",
}, async () => {
  assert.equal(inhibitorCount(), 0, "test requires no pre-existing OpenCode Keep Awake lease");
  const stream = controlledEvents();
  const location = { directory: process.cwd() };
  const hooks = version === "V1" ? await OpenCodeKeepAwake.server({}) : null;
  const dispose = hooks ? () => hooks.dispose() : OpenCodeKeepAwake.setup({
    location,
    event: { subscribe: (options) => stream.subscribe(options) },
  });
  const emit = async (v1Type, v1Data, v2Type, v2Data) => {
    if (hooks) send(hooks, v1Type, v1Data);
    else await stream.push(v2Event(v2Type, v2Data, location));
  };

  try {
    await emit("session.created", { info: { id: "integration-session" } },
      "session.created", { sessionID: "integration-session", location });
    await emit("session.status", {
      sessionID: "integration-session",
      status: { type: "busy" },
    }, "session.execution.started", { sessionID: "integration-session" });
    await waitForCount(1, "busy work to acquire a GNOME inhibitor");

    await emit("permission.asked", { id: "permission-1", sessionID: "integration-session" },
      "permission.asked", { id: "permission-1", sessionID: "integration-session" });
    await waitForCount(0, "a permission wait to release the GNOME inhibitor");

    await emit("permission.replied", {
      requestID: "permission-1",
      sessionID: "integration-session",
      reply: "once",
    }, "permission.replied", { requestID: "permission-1", sessionID: "integration-session" });
    await waitForCount(1, "resumed work to reacquire a GNOME inhibitor");

    await emit("question.asked", { id: "question-1", sessionID: "integration-session" },
      "form.created", { form: { id: "question-1", sessionID: "integration-session" } });
    await waitForCount(0, "a question wait to release the GNOME inhibitor");
    await emit("question.replied", { requestID: "question-1", sessionID: "integration-session" },
      "form.replied", { id: "question-1", sessionID: "integration-session" });
    await waitForCount(1, "a question answer to restore the GNOME inhibitor");

    await emit("session.status", {
      sessionID: "integration-session",
      status: { type: "idle" },
    }, "session.execution.succeeded", { sessionID: "integration-session" });
    await waitForCount(0, "idle work to release the GNOME inhibitor");
    await emit("session.status", { sessionID: "integration-session", status: { type: "busy" } },
      "session.step.started", { sessionID: "integration-session" });
    await waitForCount(1, "work to resume before plugin cleanup");
  } finally {
    dispose();
    await waitForCount(0, "plugin disposal to release the GNOME inhibitor");
  }
});
