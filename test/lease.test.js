import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const leasePath = fileURLToPath(new URL("../src/lease.js", import.meta.url));

test("standalone lease announces readiness and exits when its stdin closes", async () => {
  const child = spawn(process.execPath, [leasePath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (stdout.split(/\r?\n/).includes("CODEX_KEEP_AWAKE_LEASE_READY")) readyResolve(true);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.once("close", () => readyResolve(false));

  try {
    assert.equal(await ready, true, stderr);
    const exitedBeforeRelease = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(exitedBeforeRelease, false, "the lease should remain alive while stdin is open");
  } finally {
    child.stdin.end();
  }

  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(stdout, "CODEX_KEEP_AWAKE_LEASE_READY\n");
});
