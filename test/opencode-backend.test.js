import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LEASE_READY_LINE } from "../src/lease.js";
import { createOpenCodeBackend } from "../src/opencode-backend.js";
import { WindowsExecutionStateBackend } from "../src/windows-backend.js";
import { portalClient, waitFor } from "./helpers/fake-portal-client.js";

test("OpenCode selects the Windows execution-state backend for Windows", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  let invocation;
  const backend = createOpenCodeBackend("win32", {
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });

  assert.ok(backend instanceof WindowsExecutionStateBackend);
  backend.setRequired(true);
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.args.at(-2), "-File");
  assert.match(invocation.args.at(-1), /windows-keep-awake\.ps1$/);
  child.stdout.write(`${LEASE_READY_LINE}\n`);
  backend.close();
});

test("OpenCode selects an in-process XDG portal backend for Linux", async () => {
  const fake = portalClient();
  const backend = createOpenCodeBackend("linux", { dbus: fake.dbus });

  assert.equal(backend.constructor.name, "PortalInhibitorBackend");
  backend.setRequired(true);
  await waitFor(() => fake.calls.some((call) => call.member === "Inhibit"));
  fake.respond();
  await waitFor(() => backend.status().active);
  const inhibit = fake.calls.find((call) => call.member === "Inhibit");
  assert.equal(inhibit.body[2].reason.value, "OpenCode is running active work");
  await backend.close();
  assert.ok(fake.calls.some((call) => call.member === "Close"));
});

test("OpenCode leaves unsupported platforms without a sleep backend", () => {
  assert.equal(createOpenCodeBackend("darwin"), null);
});
