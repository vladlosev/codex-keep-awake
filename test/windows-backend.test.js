import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LEASE_READY_LINE } from "../src/lease.js";
import { WindowsExecutionStateBackend } from "../src/windows-backend.js";

test("Windows backend starts a quiet PowerShell lease and releases it on demand", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  let invocation;
  const backend = new WindowsExecutionStateBackend({
    command: "powershell.exe",
    helperScriptPath: "C:\\checkout\\src\\windows-keep-awake.ps1",
    platform: "win32",
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });

  backend.setRequired(true);

  assert.deepEqual(invocation, {
    command: "powershell.exe",
    args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", "C:\\checkout\\src\\windows-keep-awake.ps1",
    ],
    options: { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  });

  child.emit("spawn");
  child.stdout.write(`${LEASE_READY_LINE}\r\n`);
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

test("Windows helper requests system wake without keeping the display on and releases in finally", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const helper = await readFile(path.join(root, "src", "windows-keep-awake.ps1"), "utf8");

  assert.match(helper, /\$active\s*=\s*\[uint32\]2147483649/);
  assert.doesNotMatch(helper, /\$active\s*=\s*\[uint32\]2147483651/);
  assert.ok(helper.includes(LEASE_READY_LINE));
  assert.match(helper, /while\s*\(\$null\s*-ne\s*\[Console\]::In\.ReadLine\(\)\)/);
  assert.match(helper, /finally\s*\{[\s\S]*SetThreadExecutionState\(\$continuous\)/);
});

test("Windows backend reports unsupported platforms without spawning", () => {
  let spawnCount = 0;
  const backend = new WindowsExecutionStateBackend({
    helperScriptPath: "/checkout/src/windows-keep-awake.ps1",
    platform: "linux",
    spawnProcess() {
      spawnCount += 1;
    },
  });

  backend.setRequired(true);

  assert.equal(spawnCount, 0);
  assert.equal(backend.status().required, true);
  assert.match(backend.status().error, /only available on Windows/);
});

test("PowerShell parses the helper on Windows", { skip: process.platform !== "win32" }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const helper = path.join(root, "src", "windows-keep-awake.ps1").replaceAll("'", "''");
  const { execFileSync } = await import("node:child_process");
  execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${helper}', [ref]$tokens, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
  ], { stdio: "pipe", windowsHide: true });
});
