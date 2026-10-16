import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeHooks } from "../src/opencode-plugin.js";

test("OpenCode event hooks change the backend lease only when activity changes", () => {
  const backend = {
    required: false,
    calls: [],
    setRequired(required) {
      this.required = required;
      this.calls.push(required);
    },
    status() {
      return { required: this.required, active: this.required, error: null, command: null };
    },
    close() {
      this.closed = true;
    },
  };
  const hooks = createOpenCodeHooks({ backend });

  hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } });
  hooks.event({ event: { type: "message.updated", properties: { sessionID: "root" } } });
  hooks.event({ event: { type: "permission.asked", properties: { id: "per_1", sessionID: "root" } } });
  hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_1", sessionID: "root", reply: "once" } } });
  hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } });
  hooks.dispose();

  assert.deepEqual(backend.calls, [true, false, true, false]);
  assert.equal(backend.closed, true);
});

test("disposed hooks cannot reopen the lease and close it only once", () => {
  const backend = {
    calls: [], closes: 0,
    setRequired(value) { this.calls.push(value); },
    status() { return { error: null }; },
    close() { this.closes += 1; },
  };
  const hooks = createOpenCodeHooks({ backend });
  hooks.dispose();
  hooks.dispose();
  hooks.event({ event: { type: "session.status", properties: {
    sessionID: "root", status: { type: "busy" },
  } } });
  assert.equal(backend.closes, 1);
  assert.deepEqual(backend.calls, []);
});
