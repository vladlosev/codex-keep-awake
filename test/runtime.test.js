import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "codex-keep-awake.js");

function runCli(args, dataDir, input = "", extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const inputFile = path.join(dataDir, `hook-input-${randomUUID()}.json`);
    writeFileSync(inputFile, input, { mode: 0o600 });
    const inputDescriptor = openSync(inputFile, "r");
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PLUGIN_ROOT: repoRoot, PLUGIN_DATA: dataDir, ...extraEnv },
      stdio: [inputDescriptor, "pipe", "pipe"],
    });
    closeSync(inputDescriptor);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      rm(inputFile, { force: true }).finally(() => reject(error));
    });
    child.once("close", (code) => {
      rm(inputFile, { force: true }).finally(() => resolve({ code, stdout, stderr }));
    });
  });
}

async function invokeHook(dataDir, event, extraEnv = {}) {
  const result = await runCli(["hook"], dataDir, JSON.stringify(event), extraEnv);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.trim(), `Hook emitted no JSON output; stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {});
}

async function supervisorPids(dataDir) {
  const procEntries = await readdir("/proc").catch(() => []);
  const matches = [];
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const commandLine = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    const args = commandLine.split("\0");
    if (args.includes(cliPath) && args.includes("supervisor") && args.includes(dataDir)) {
      matches.push(Number(entry));
    }
  }
  return matches;
}

async function waitForSupervisorCount(dataDir, count) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const pids = await supervisorPids(dataDir);
    if (pids.length === count) return pids;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return supervisorPids(dataDir);
}

test("concurrent hooks share one supervisor and ignore a stale Stop", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-test-"));
  const fakeBin = path.join(dataDir, "bin");
  const environment = {};
  try {
    await writeFile(path.join(dataDir, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(dataDir, "package-lock.json"), "{}\n");
    await symlink(path.join(repoRoot, "node_modules"), path.join(dataDir, "node_modules"), "dir");
    await mkdir(fakeBin);
    const fakeInhibitor = path.join(fakeBin, "gnome-session-inhibit");
    await writeFile(fakeInhibitor, "#!/bin/sh\ncat >/dev/null\n");
    await chmod(fakeInhibitor, 0o755);
    environment.CODEX_KEEP_AWAKE_GNOME_INHIBITOR = fakeInhibitor;
    const startupEvents = Array.from({ length: 6 }, (_, index) => ({
      hook_event_name: "UserPromptSubmit",
      session_id: `thread-${index}`,
      turn_id: `turn-${index}`,
    }));
    await Promise.all(startupEvents.map((event) => invokeHook(dataDir, event, environment)));

    await invokeHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-0",
      turn_id: "turn-new",
    }, environment);
    await invokeHook(dataDir, {
      hook_event_name: "Stop",
      session_id: "thread-0",
      turn_id: "turn-0",
    }, environment);
    await invokeHook(dataDir, {
      hook_event_name: "SubagentStart",
      session_id: "thread-0",
      turn_id: "turn-new",
      agent_id: "agent-review",
      agent_type: "reviewer",
    }, environment);

    const state = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.deepEqual(Object.keys(state.threads).sort(), startupEvents.map((event) => event.session_id).sort());
    assert.equal(state.threads["thread-0"].currentTurnId, "turn-new");
    assert.equal(state.threads["thread-0"].active, true);
    assert.equal(state.threads["thread-0"].subagents["agent-review"].turnId, "turn-new");
    assert.equal(typeof state.supervisor.pid, "number");
    assert.deepEqual(await waitForSupervisorCount(dataDir, 1), [state.supervisor.pid]);
  } finally {
    await runCli(["cleanup"], dataDir, "", environment);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await supervisorPids(dataDir)).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
