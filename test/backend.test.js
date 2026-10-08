import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GnomeInhibitorBackend } from "../src/backend.js";

test("GNOME backend supports an OpenCode identity and the shared standalone lease", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  let invocation;
  const backend = new GnomeInhibitorBackend({
    command: "gnome-session-inhibit",
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
    nodePath: "node",
    leaseScriptPath: "/checkout/src/lease.js",
    appId: "org.opencode.KeepAwake",
    reason: "OpenCode is running active work",
  });

  backend.setRequired(true);

  assert.deepEqual(invocation, {
    command: "gnome-session-inhibit",
    args: [
      "--app-id", "org.opencode.KeepAwake",
      "--inhibit", "suspend",
      "--reason", "OpenCode is running active work",
      "node", "/checkout/src/lease.js",
    ],
    options: { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  });

  child.emit("spawn");
  child.stdout.write("CODEX_KEEP_AWAKE_LEASE_READY\n");
  assert.equal(backend.status().active, true);
  assert.equal(backend.status().required, true);

  backend.release();
  assert.equal(child.stdin.writableEnded, true);
  child.emit("exit", 0, null);
  assert.deepEqual(backend.status(), {
    required: false,
    active: false,
    error: null,
    command: null,
  });
});
