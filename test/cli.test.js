import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(dataDir, input, { args = ["hook"], pluginRoot = repoRoot, nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const inputFile = path.join(dataDir, `hook-input-${randomUUID()}.json`);
    writeFileSync(inputFile, input, { mode: 0o600 });
    const descriptor = openSync(inputFile, "r");
    const child = spawn(process.execPath, [...nodeArgs, path.join(pluginRoot, "scripts", "codex-keep-awake.js"), ...args], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: dataDir,
        PATH: "",
        CODEX_KEEP_AWAKE_SOCKET: path.join(dataDir, "missing-app-server.sock"),
        CODEX_KEEP_AWAKE_GNOME_INHIBITOR: path.join(dataDir, "missing-inhibitor"),
      },
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

test("a copied plugin handles its first hook without npm or installed packages", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "codex keep awake 'native-"));
  const pluginRoot = path.join(parent, "plugin checkout");
  const dataDir = path.join(parent, "private plugin data");
  await mkdir(dataDir);
  await mkdir(pluginRoot);
  let supervisorPid;
  try {
    for (const directory of ["src", "scripts"]) {
      await cp(path.join(repoRoot, directory), path.join(pluginRoot, directory), { recursive: true });
    }
    await writeFile(path.join(pluginRoot, "package.json"), '{"type":"module"}\n');
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-without-dependencies",
      turn_id: "turn-1",
      prompt: "private prompt text",
    });
    const result = await runCli(dataDir, event, { pluginRoot });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const state = await readFile(path.join(dataDir, "state.json"), "utf8");
    const parsedState = JSON.parse(state);
    supervisorPid = parsedState.supervisor.pid;
    assert.equal(parsedState.threads["thread-without-dependencies"].active, true);
    assert.equal(state.includes("private prompt text"), false);
    const files = await readdir(dataDir);
    for (const unnecessary of ["node_modules", "package.json", "package-lock.json"]) {
      assert.equal(files.includes(unnecessary), false);
    }
  } finally {
    await runCli(dataDir, "", { args: ["cleanup"], pluginRoot });
    const deadline = Date.now() + 2000;
    let running = false;
    do {
      const command = await readFile(`/proc/${supervisorPid}/cmdline`, "utf8").catch(() => "");
      running = command.split("\0").includes(path.join(pluginRoot, "scripts", "codex-keep-awake.js"));
      if (running) await new Promise((resolve) => setTimeout(resolve, 20));
    } while (running && Date.now() < deadline);
    assert.equal(running, false, "the copied supervisor must exit before its state directory is removed");
    await rm(parent, { recursive: true, force: true });
  }
});

test("malformed hook input stays advisory and creates no state", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-invalid-"));
  try {
    const result = await runCli(dataDir, "{not-json");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    await assert.rejects(readFile(path.join(dataDir, "state.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("legacy setup succeeds offline without creating dependency files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-setup-"));
  try {
    const result = await runCli(dataDir, "", { args: ["setup"] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /no runtime dependencies/i);
    assert.deepEqual(await readdir(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an unavailable built-in WebSocket produces an actionable hook advisory", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-no-websocket-"));
  try {
    const result = await runCli(dataDir, "{}", {
      nodeArgs: ["--import", "data:text/javascript,globalThis.WebSocket=undefined"],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).systemMessage, /Node\.js 24\.17\.0.*built-in WebSocket/i);
    await assert.rejects(readFile(path.join(dataDir, "state.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an unverified Node major produces a hook advisory instead of silently losing parser limits", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-node-major-"));
  try {
    const result = await runCli(dataDir, "{}", {
      nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent('Object.defineProperty(process.versions, "node", { value: "25.0.0" })')}`],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).systemMessage, /Node 24 series/i);
    await assert.rejects(readFile(path.join(dataDir, "state.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
