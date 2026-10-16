import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import { setupOpenCodeV2 } from "../src/opencode-v2-plugin.js";
import { controlledEvents, recordingBackend, v2Event } from "./helpers/opencode.js";

const location = { directory: "/project" };
function fixture(t, { records = {}, get, subscribe, loadedLocation = location } = {}) {
  const stream = controlledEvents();
  const backend = recordingBackend();
  const warnings = [];
  const reads = [];
  const ctx = {
    location: loadedLocation,
    event: { subscribe: subscribe ?? ((options) => stream.subscribe(options)) },
    session: { async get(input, options) {
      reads.push(input.sessionID);
      if (get) return get(input, options);
      return records[input.sessionID] ?? { id: input.sessionID, location };
    } },
  };
  const cleanup = setupOpenCodeV2(ctx, { backend, warn: (message) => warnings.push(message) });
  t.after(cleanup);
  return {
    backend, warnings, reads, cleanup, stream,
    send: (type, data, where) => stream.push(v2Event(type, data, where)),
  };
}

test("V2 subscription drives busy, waits, resumption, and completion", async (t) => {
  const f = fixture(t);
  await f.send("session.execution.started", { sessionID: "ses_root" });
  await f.send("permission.asked", { sessionID: "ses_root", id: "per_1" });
  await f.send("permission.replied", { sessionID: "ses_root", requestID: "per_1" });
  await f.send("form.created", { form: { sessionID: "ses_root", id: "frm_1" } });
  await f.send("form.cancelled", { sessionID: "ses_root", id: "frm_1" });
  await f.send("session.execution.succeeded", { sessionID: "ses_root" });
  assert.deepEqual(f.backend.calls, [true, false, true, false, true, false]);
  assert.deepEqual(f.reads, ["ses_root"]);
});

test("creation supplies metadata and untracked terminal/reply events need no reads", async (t) => {
  const f = fixture(t, { get() { throw new Error("unexpected lookup"); } });
  await f.send("session.created", { sessionID: "ses_root", location });
  await f.send("session.step.started", { sessionID: "ses_root" });
  for (const type of ["session.deleted", "session.execution.failed", "permission.replied", "form.replied"]) {
    await f.send(type, { sessionID: "ses_absent", requestID: "per_1", id: "frm_1" });
  }
  assert.equal(f.backend.required, true);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.warnings, []);
});

test("location-less resumed children recover ancestry and respect active siblings", async (t) => {
  const f = fixture(t, { records: {
    ses_child: { id: "ses_child", parentID: "ses_root", location },
    ses_sibling: { id: "ses_sibling", parentID: "ses_root", location },
  } });
  await f.send("session.execution.started", { sessionID: "ses_root" });
  await f.send("session.execution.started", { sessionID: "ses_child" });
  await f.send("permission.asked", { sessionID: "ses_child", id: "per_1" });
  assert.equal(f.backend.required, false);
  await f.send("session.execution.started", { sessionID: "ses_sibling" });
  assert.equal(f.backend.required, true);
  await f.send("session.execution.interrupted", { sessionID: "ses_sibling" });
  assert.equal(f.backend.required, false);
  await f.send("permission.replied", { sessionID: "ses_child", requestID: "per_1" });
  assert.equal(f.backend.required, true);
  assert.deepEqual(f.reads, ["ses_root", "ses_child", "ses_sibling"]);
});

test("unknown parents are recovered before a child's wait is applied", async (t) => {
  const f = fixture(t, { records: {
    ses_child: { id: "ses_child", parentID: "ses_parent", location },
    ses_parent: { id: "ses_parent", parentID: "ses_root", location },
  } });
  await f.send("session.execution.started", { sessionID: "ses_root" });
  await f.send("permission.asked", { sessionID: "ses_child", id: "per_1" });
  assert.equal(f.backend.required, false);
  assert.deepEqual(f.reads, ["ses_root", "ses_child", "ses_parent"]);
});

test("foreign directories, workspaces, conflicting locations and global forms are ignored", async (t) => {
  const f = fixture(t, { records: { ses_foreign: { id: "ses_foreign", location: { directory: "/elsewhere" } } } });
  await f.send("session.execution.started", { sessionID: "ses_other" }, { directory: "/project/subdir" });
  await f.send("session.execution.started", { sessionID: "ses_workspace" }, { ...location, workspaceID: "wrk_other" });
  await f.send("session.execution.started", { sessionID: "ses_foreign" });
  await f.send("session.created", { sessionID: "ses_conflict", location: { directory: "/other" } }, location);
  await f.send("form.created", { form: { sessionID: "global", id: "frm_1" } });
  assert.deepEqual(f.backend.calls, []);
  assert.deepEqual(f.reads, ["ses_foreign"]);
  await f.send("session.created", { sessionID: "ses_root", location: { directory: "/project/./" } });
  await f.send("session.execution.started", { sessionID: "ses_root" });
  assert.equal(f.backend.required, true);
});

test("matching workspace IDs are accepted", async (t) => {
  const where = { ...location, workspaceID: "wrk_1" };
  const f = fixture(t, { loadedLocation: where });
  await f.send("session.created", { sessionID: "ses_root", location: where }, where);
  await f.send("session.execution.started", { sessionID: "ses_root" }, where);
  assert.equal(f.backend.required, true);
});

for (const ending of ["end", "fail"]) {
  test(`V2 stream ${ending} releases the lease and logs no raw error`, async (t) => {
    const f = fixture(t);
    await f.send("session.execution.started", { sessionID: "ses_root" });
    f.stream[ending](new Error("SECRET"));
    await tick();
    assert.equal(f.backend.required, false);
    assert.equal(f.backend.closes, 1);
    assert.equal(f.warnings.length, 1);
    assert.doesNotMatch(f.warnings[0], /SECRET/);
    f.cleanup();
    assert.equal(f.backend.closes, 1);
  });
}

test("synchronous subscribe failure is contained", async (t) => {
  const f = fixture(t, { subscribe() { throw new Error("SECRET"); } });
  await tick();
  assert.equal(f.backend.closes, 1);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /SECRET/);
});

test("cleanup cancels a pending read and prevents late activity", async (t) => {
  const entered = Promise.withResolvers();
  const result = Promise.withResolvers();
  let lookupSignal;
  const f = fixture(t, { get(_input, { signal }) {
    lookupSignal = signal;
    entered.resolve();
    return result.promise;
  } });
  const sent = f.send("session.execution.started", { sessionID: "ses_root" });
  await entered.promise;
  f.cleanup();
  f.cleanup();
  assert.equal(lookupSignal.aborted, true);
  result.resolve({ id: "ses_root", location });
  await sent;
  await tick();
  assert.deepEqual(f.backend.calls, []);
  assert.equal(f.backend.closes, 1);
  assert.deepEqual(f.warnings, []);
});

test("metadata deletion races do not stop observation; transport failure does", async (t) => {
  const f = fixture(t, { get({ sessionID }) {
    if (sessionID === "ses_missing") throw Object.assign(new Error("SECRET"), { _tag: "SessionNotFoundError" });
    if (sessionID === "ses_broken") throw new Error("SECRET");
    return { id: sessionID, location };
  } });
  await f.send("session.execution.started", { sessionID: "ses_root" });
  await f.send("session.execution.started", { sessionID: "ses_missing" });
  assert.equal(f.backend.required, true);
  assert.deepEqual(f.warnings, []);
  await f.send("session.execution.started", { sessionID: "ses_broken" });
  await tick();
  assert.equal(f.backend.required, false);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /SECRET/);
});

test("metadata reads have a deadline even when the host ignores request cancellation", async (t) => {
  const f = fixture(t, { get() { return new Promise(() => {}); } });
  const stopped = Promise.withResolvers();
  const close = f.backend.close.bind(f.backend);
  f.backend.close = () => { close(); stopped.resolve(); };
  void f.send("session.execution.started", { sessionID: "ses_root" });
  const timeout = new AbortController();
  try {
    await Promise.race([
      stopped.promise,
      delay(2000, null, { signal: timeout.signal }).then(() => assert.fail("metadata timeout did not release the lease")),
    ]);
    assert.equal(f.backend.closes, 1);
    assert.equal(f.warnings.length, 1);
  } finally {
    timeout.abort();
  }
});

test("moving out evicts descendants while other local work remains protected", async (t) => {
  const f = fixture(t, { records: { ses_root: { id: "ses_root", location: { directory: "/other" } } } });
  for (const [sessionID, parentID] of [["ses_root"], ["ses_child", "ses_root"], ["ses_other"]]) {
    await f.send("session.created", { sessionID, parentID, location });
    await f.send("session.execution.started", { sessionID });
  }
  await f.send("session.moved", { sessionID: "ses_root" });
  assert.equal(f.backend.required, true);
  await f.send("session.execution.succeeded", { sessionID: "ses_other" });
  assert.equal(f.backend.required, false);
});

test("cleanup of one instance leaves another instance's lease intact", async (t) => {
  const a = fixture(t);
  const b = fixture(t);
  await a.send("session.execution.started", { sessionID: "ses_a" });
  await b.send("session.execution.started", { sessionID: "ses_b" });
  a.cleanup();
  await a.stream.push(v2Event("session.execution.started", { sessionID: "ses_late" }));
  assert.equal(a.backend.required, false);
  assert.equal(b.backend.required, true);
  assert.deepEqual(a.warnings, []);
});
