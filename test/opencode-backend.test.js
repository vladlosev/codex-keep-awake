import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createOpenCodeBackend } from "../src/opencode-backend.js";
import { WindowsExecutionStateBackend } from "../src/windows-backend.js";

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
});

test("OpenCode leaves unsupported platforms without a sleep backend", () => {
  assert.equal(createOpenCodeBackend("darwin"), null);
});
