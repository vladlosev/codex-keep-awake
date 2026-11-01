import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { StdinLeaseBackend } from "../src/lease-backend.js";
import { LEASE_READY_LINE } from "../src/lease.js";

function makeChild({ exitOnStdinEnd = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    child.emit("exit", null, signal);
    return true;
  };
  if (exitOnStdinEnd) {
    child.stdin.once("finish", () => setImmediate(() => child.emit("exit", 0, null)));
  }
  return child;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), "timed out waiting for backend state");
}

test("lease backend times out readiness, retries autonomously, reports changes and cancels retry on release", async () => {
  const children = [];
  const notifications = [];
  const backend = new StdinLeaseBackend({
    command: "node",
    args: ["portal-helper.js"],
    platform: "linux",
    supportedPlatform: "linux",
    leaseName: "The XDG Desktop Portal suspend inhibitor",
    failureMessage: "The XDG Desktop Portal suspend inhibitor is unavailable",
    startErrorMessage: "The XDG Desktop Portal helper could not start",
    readinessTimeoutMs: 20,
    retryDelayMs: 20,
    teardownTimeoutMs: 10,
    spawnProcess() {
      const child = makeChild({ exitOnStdinEnd: true });
      children.push(child);
      return child;
    },
  });
  const unsubscribe = backend.subscribeStatus((status) => notifications.push(status));

  backend.setRequired(true);
  await waitFor(() => children.length === 2);
  assert.equal(children[0].stdin.writableEnded, true);
  assert.ok(notifications.some((status) => status.error === "The XDG Desktop Portal suspend inhibitor is unavailable"));

  children[1].stdout.write(`${LEASE_READY_LINE}\n`);
  assert.equal(backend.status().active, true);
  assert.equal(backend.status().error, null);
  assert.ok(notifications.some((status) => status.error));
  assert.ok(notifications.some((status) => status.active));

  backend.release();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(backend.status().required, false);
  assert.equal(backend.status().active, false);
  assert.equal(children.length, 2, "release must cancel a pending automatic retry");

  backend.setRequired(true);
  assert.equal(children.length, 3, "a released backend can be required again");
  children[2].stdout.write(`${LEASE_READY_LINE}\n`);
  backend.close();
  unsubscribe();
});

test("lease backend forcibly terminates a helper that ignores stdin closure", async () => {
  const child = makeChild();
  const backend = new StdinLeaseBackend({
    command: "node",
    args: [],
    platform: "linux",
    supportedPlatform: "linux",
    readinessTimeoutMs: 1000,
    teardownTimeoutMs: 10,
    spawnProcess: () => child,
  });

  backend.setRequired(true);
  child.stdout.write(`${LEASE_READY_LINE}\n`);
  backend.close();
  await waitFor(() => child.killedWith.length === 1);
  assert.deepEqual(child.killedWith, ["SIGKILL"]);
});
