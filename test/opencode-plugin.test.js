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
