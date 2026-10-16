import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeActivityTracker } from "../src/opencode-activity.js";

const event = (type, properties) => ({ type, properties });
const created = (id, parentID) => event("session.created", {
  sessionID: id,
  info: { id, ...(parentID ? { parentID } : {}) },
});
const status = (sessionID, type) => event("session.status", {
  sessionID,
  status: { type },
});

test("busy and retry sessions require inhibition until they become idle", () => {
  const activity = new OpenCodeActivityTracker();

  assert.equal(activity.handle(status("root", "busy")), true);
  assert.equal(activity.handle(status("root", "retry")), true);
  assert.equal(activity.handle(status("root", "idle")), false);
});

test("permission and question requests pause only their session until answered", () => {
  const activity = new OpenCodeActivityTracker();
  activity.handle(created("root"));
  activity.handle(status("root", "busy"));

  assert.equal(activity.handle(event("permission.asked", { id: "per_1", sessionID: "root" })), false);
  assert.equal(activity.handle(event("permission.replied", {
    sessionID: "root", requestID: "per_1", reply: "once",
  })), true);
  assert.equal(activity.handle(event("question.asked", { id: "que_1", sessionID: "root" })), false);
  assert.equal(activity.handle(event("question.rejected", { sessionID: "root", requestID: "que_1" })), true);
});

test("a child wait pauses its busy ancestors while an active sibling retains inhibition", () => {
  const activity = new OpenCodeActivityTracker();
  activity.handle(created("root"));
  activity.handle(created("child-a", "root"));
  activity.handle(created("child-b", "root"));
  activity.handle(status("root", "busy"));
  activity.handle(status("child-a", "busy"));
  activity.handle(status("child-b", "busy"));

  assert.equal(activity.handle(event("question.asked", { id: "que_child", sessionID: "child-a" })), true);
  assert.equal(activity.handle(status("child-b", "idle")), false);
});

test("deleting a child clears its pending requests without losing active parent work", () => {
  const activity = new OpenCodeActivityTracker();
  activity.handle(created("root"));
  activity.handle(created("child", "root"));
  activity.handle(status("root", "busy"));
  activity.handle(status("child", "busy"));
  activity.handle(event("permission.asked", { id: "per_child", sessionID: "child" }));

  assert.equal(activity.isRequired(), false);
  assert.equal(activity.handle(event("session.deleted", {
    sessionID: "child", info: { id: "child" },
  })), true);
});

for (const terminal of [status("child", "idle"), event("session.idle", { sessionID: "child" }),
  event("session.error", { sessionID: "child" })]) {
  test(`${terminal.type} clears waits before the next execution and releases waiting ancestors`, () => {
    const activity = new OpenCodeActivityTracker();
    activity.handle(created("root"));
    activity.handle(created("child", "root"));
    activity.handle(status("root", "busy"));
    activity.handle(status("child", "busy"));
    activity.handle(event("permission.asked", { id: "per_1", sessionID: "child" }));
    activity.handle(event("question.asked", { id: "que_1", sessionID: "child" }));
    assert.equal(activity.isRequired(), false);
    assert.equal(activity.handle(terminal), true);
    activity.handle(status("root", "idle"));
    assert.equal(activity.handle(status("child", "busy")), true);
  });
}
