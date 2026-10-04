import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleHook } from "./hook-runtime.js";
import { LEASE_READY_LINE } from "./backend.js";
import {
  ensurePrivateDirectory,
  processIdentityIsAlive,
  readState,
  withLockedState,
} from "./state.js";
import { runSupervisor } from "./supervisor.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(scriptDirectory, "..");
const executablePath = path.join(pluginRoot, "scripts", "codex-keep-awake.js");

function parseArguments(args) {
  const positional = [];
  let dataDirectory = process.env.PLUGIN_DATA;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--data-dir") {
      dataDirectory = args[index + 1];
      if (!dataDirectory) throw new Error("--data-dir requires a path");
      index += 1;
    } else if (value.startsWith("--data-dir=")) {
      dataDirectory = value.slice("--data-dir=".length);
      if (!dataDirectory) throw new Error("--data-dir requires a path");
    } else {
      positional.push(value);
    }
  }
  if (!dataDirectory) {
    dataDirectory = process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Codex", "KeepAwake")
      : path.join(os.homedir(), ".local", "share", "codex-keep-awake");
  }
  return { positional, dataDirectory: path.resolve(dataDirectory) };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function setupCommand(dataDirectory) {
  return `${shellQuote(process.execPath)} ${shellQuote(executablePath)} setup --data-dir ${shellQuote(dataDirectory)}`;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error("Hook input exceeded the 1 MiB limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function installDependencies(dataDirectory) {
  ensurePrivateDirectory(dataDirectory);
  copyFileSync(path.join(pluginRoot, "package.json"), path.join(dataDirectory, "package.json"));
  copyFileSync(path.join(pluginRoot, "package-lock.json"), path.join(dataDirectory, "package-lock.json"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, [
    "ci", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund",
  ], {
    cwd: dataDirectory,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with status ${result.status ?? "unknown"}`);
  const requireFromData = createRequire(path.join(dataDirectory, "package.json"));
  requireFromData("ws");
}

async function handleHookCommand(dataDirectory) {
  let event;
  try {
    const input = await readStdin();
    event = JSON.parse(input);
  } catch {
    // Codex hooks are advisory. Invalid input must not block the requested
    // operation or print content that could contain prompts.
    writeJson({});
    return;
  }

  try {
    const requireFromData = createRequire(path.join(dataDirectory, "package.json"));
    requireFromData("ws");
  } catch {
    writeJson({
      systemMessage: `Codex Keep Awake needs its locked runtime dependencies. Run this command: ${setupCommand(dataDirectory)}`,
    });
    return;
  }

  try {
    handleHook(dataDirectory, pluginRoot, event);
    writeJson({});
  } catch (error) {
    writeJson({ systemMessage: `Codex Keep Awake could not update its private state: ${error.message}` });
  }
}

async function waitForLeaseEnd() {
  process.stdout.write(`${LEASE_READY_LINE}\n`);
  for await (const _chunk of process.stdin) {
    // The parent supervisor keeps this pipe open for the entire protection
    // lease. EOF means the inhibitor should release and exit.
  }
}

function status(dataDirectory) {
  const state = readState(dataDirectory);
  const supervisorRunning = processIdentityIsAlive(state.supervisor);
  const runtime = supervisorRunning
    ? state.runtime
    : Object.keys(state.threads).length > 0
      ? {
        ...(state.runtime ?? {}),
        appServerConnected: false,
        automaticPauseResume: false,
        degradedReason: "supervisor_not_running",
        observationMessage: "The background observer stopped; it will restart on the next Codex hook.",
        protectionRequired: false,
        inhibitionActive: false,
      }
      : state.runtime;
  writeJson({
    dataDirectory,
    supervisor: supervisorRunning ? state.supervisor : null,
    running: supervisorRunning,
    registeredThreads: Object.keys(state.threads).length,
    runtime,
    threads: Object.values(state.threads).map((thread) => ({
      threadId: thread.threadId,
      turnId: thread.currentTurnId,
      active: thread.active,
      waiting: thread.waiting,
      subagents: Object.keys(thread.subagents ?? {}).length,
    })),
  });
}

function cleanup(dataDirectory) {
  let supervisor = null;
  withLockedState(dataDirectory, (state) => {
    supervisor = state.supervisor;
    state.supervisor = null;
    state.runtime = null;
    state.threads = Object.create(null);
  });
  let stopped = false;
  if (processIdentityIsAlive(supervisor)) {
    try {
      process.kill(supervisor.pid, "SIGTERM");
      stopped = true;
    } catch {
      stopped = false;
    }
  }
  writeJson({ cleaned: true, supervisorSignalled: stopped });
}

export async function main(args = process.argv.slice(2)) {
  const { positional, dataDirectory } = parseArguments(args);
  const command = positional.shift();
  if (command === "setup") {
    installDependencies(dataDirectory);
    process.stdout.write(`Installed locked runtime dependencies in ${dataDirectory}\n`);
  } else if (command === "hook") {
    await handleHookCommand(dataDirectory);
  } else if (command === "status") {
    status(dataDirectory);
  } else if (command === "cleanup") {
    cleanup(dataDirectory);
  } else if (command === "supervisor") {
    const instanceId = process.env.CODEX_KEEP_AWAKE_SUPERVISOR_ID;
    if (!instanceId) throw new Error("The supervisor can only be started by the hook runtime");
    runSupervisor(dataDirectory, instanceId);
  } else if (command === "lease") {
    await waitForLeaseEnd();
  } else {
    throw new Error("Usage: codex-keep-awake <setup|hook|status|cleanup>");
  }
}
