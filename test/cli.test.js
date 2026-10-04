import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shellQuote } from "../src/cli.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "codex-keep-awake.js");

function runCli(dataDir, input) {
  return new Promise((resolve, reject) => {
    const inputFile = path.join(dataDir, `hook-input-${randomUUID()}.json`);
    writeFileSync(inputFile, input, { mode: 0o600 });
    const descriptor = openSync(inputFile, "r");
    const child = spawn(process.execPath, [cliPath, "hook"], {
      cwd: repoRoot,
      env: { ...process.env, PLUGIN_ROOT: repoRoot, PLUGIN_DATA: dataDir },
      stdio: [descriptor, "pipe", "pipe"],
    });
    closeSync(descriptor);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      rm(inputFile, { force: true }).finally(() => resolve({ code, stdout, stderr }));
    });
  });
}

test("missing dependencies return an exact quoted setup command and malformed input stays advisory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "codex keep awake 'missing-"));
  const dataDir = path.join(parent, "private plugin data");
  await mkdir(dataDir);
  try {
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-missing-dependency",
      turn_id: "turn-1",
      prompt: "private prompt text",
    });
    const result = await runCli(dataDir, event);
    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} setup --data-dir ${shellQuote(dataDir)}`;
    assert.equal(response.systemMessage, `Codex Keep Awake needs its locked runtime dependencies. Run this command: ${command}`);
    assert.equal(response.systemMessage.includes("private prompt text"), false);

    const malformed = await runCli(dataDir, "{not-json");
    assert.equal(malformed.code, 0, malformed.stderr);
    assert.deepEqual(JSON.parse(malformed.stdout), {});
    await assert.rejects(readFile(path.join(dataDir, "state.json")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
