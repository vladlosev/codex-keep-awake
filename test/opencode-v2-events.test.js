import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenCodeV2Event as normalize } from "../src/opencode-v2-events.js";
import { OpenCodeActivityTracker } from "../src/opencode-activity.js";

const wire = (type, data) => ({ type, data });
const status = (type) => ({ type: "session.status", properties: { sessionID: "ses_root", status: { type } } });
const cases = [
  ["session.created", { sessionID: "ses_root", parentID: "ses_parent", title: "private" },
    { type: "session.created", properties: { info: { id: "ses_root", parentID: "ses_parent" } } }],
  ...["session.execution.started", "session.step.started"].map((type) => [type, { sessionID: "ses_root" }, status("busy")]),
  ["session.retry.scheduled", { sessionID: "ses_root", error: { message: "private" } }, status("retry")],
  ...["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"].map((type) =>
    [type, { sessionID: "ses_root", error: "private" }, { type: "session.idle", properties: { sessionID: "ses_root" } }]),
  ["session.deleted", { sessionID: "ses_root" }, { type: "session.deleted", properties: { sessionID: "ses_root" } }],
  ["session.status", { sessionID: "ses_root", status: { type: "retry", message: "private" } }, status("retry")],
  ["permission.asked", { sessionID: "ses_root", id: "per_1", resources: ["private"] },
    { type: "permission.asked", properties: { sessionID: "ses_root", id: "per_1" } }],
  ["permission.replied", { sessionID: "ses_root", requestID: "per_1", reply: "once" },
    { type: "permission.replied", properties: { sessionID: "ses_root", requestID: "per_1" } }],
  ["form.created", { form: { sessionID: "ses_root", id: "frm_1", fields: ["private"] } },
    { type: "question.asked", properties: { sessionID: "ses_root", id: "frm_1" } }],
  ["form.replied", { sessionID: "ses_root", id: "frm_1", answer: { secret: "private" } },
    { type: "question.replied", properties: { sessionID: "ses_root", requestID: "frm_1" } }],
  ["form.cancelled", { sessionID: "ses_root", id: "frm_1" },
    { type: "question.rejected", properties: { sessionID: "ses_root", requestID: "frm_1" } }],
];

for (const [type, data, expected] of cases) {
  test(`V2 ${type} copies only the tracker fields`, () => {
    const input = wire(type, data);
    const before = structuredClone(input);
    assert.deepEqual(normalize(input), expected);
    assert.deepEqual(input, before);
  });
}

test("malformed, unrelated, V1-shaped, and non-session inputs are ignored", () => {
  for (const input of [null, [], {}, wire("session.execution.started", null),
    wire("session.execution.started", { sessionID: "" }), wire("session.execution.started", { sessionID: 1 }),
    wire("permission.asked", { sessionID: "ses_root", id: "" }),
    wire("permission.replied", { sessionID: "ses_root" }), wire("form.created", {}),
    wire("form.created", { form: { id: "frm_1", sessionID: "global" } }),
    wire("form.replied", { sessionID: "global", id: "frm_1" }),
    wire("session.status", { sessionID: "ses_root", status: { type: "unknown" } }),
    wire("session.tool.success", { sessionID: "ses_root" }), wire("session.step.ended", { sessionID: "ses_root" }),
    { type: "session.idle", properties: { sessionID: "ses_root" } }]) {
    assert.equal(normalize(input), null, JSON.stringify(input));
  }
});

test("overlapping V2 waits and sibling work obey the shared activity rules", () => {
  const activity = new OpenCodeActivityTracker();
  const send = (type, data) => activity.handle(normalize(wire(type, data)));
  send("session.created", { sessionID: "ses_root" });
  send("session.created", { sessionID: "ses_child", parentID: "ses_root" });
  send("session.created", { sessionID: "ses_sibling", parentID: "ses_root" });
  send("session.execution.started", { sessionID: "ses_root" });
  send("session.execution.started", { sessionID: "ses_child" });
  send("permission.asked", { sessionID: "ses_child", id: "per_1" });
  send("permission.asked", { sessionID: "ses_child", id: "per_2" });
  assert.equal(send("form.created", { form: { sessionID: "ses_child", id: "frm_1" } }), false);
  assert.equal(send("session.execution.started", { sessionID: "ses_sibling" }), true);
  assert.equal(send("session.execution.succeeded", { sessionID: "ses_sibling" }), false);
  assert.equal(send("permission.replied", { sessionID: "ses_child", requestID: "per_1" }), false);
  assert.equal(send("form.replied", { sessionID: "ses_child", id: "frm_1" }), false);
  assert.equal(send("permission.replied", { sessionID: "ses_child", requestID: "per_2" }), true);
});
