import { spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const STATE_VERSION = 1;
const LOCK_WAIT_MS = 8;
const LOCK_TIMEOUT_MS = 1800;
const EMPTY_LOCK_STALE_MS = 1000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

export function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // PLUGIN_DATA belongs to this plugin. Keep both its state and installed
  // runtime dependencies private to the current user.
  chmodSync(directory, 0o700);
}

export function defaultState() {
  return { version: STATE_VERSION, updatedAt: Date.now(), supervisor: null, runtime: null, threads: {} };
}

export function readState(directory) {
  const file = path.join(directory, "state.json");
  if (!existsSync(file)) return defaultState();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.threads !== "object" || Array.isArray(parsed.threads)) {
    throw new Error("The private state file has an unsupported format");
  }
  parsed.threads = Object.assign(Object.create(null), parsed.threads);
  parsed.runtime ??= null;
  for (const thread of Object.values(parsed.threads)) {
    thread.subagents = Object.assign(Object.create(null), thread.subagents ?? {});
    thread.revision ??= 0;
    thread.observation ??= "pending";
    thread.observationFailureAt ??= null;
  }
  return parsed;
}

function writeState(directory, state) {
  const file = path.join(directory, "state.json");
  const temporary = path.join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, `${JSON.stringify(state)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
      return fieldsAfterCommand[19] ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 300,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }
  return null;
}

export function processIdentityIsAlive(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  if (typeof identity.startToken !== "string" || identity.startToken.length === 0) return false;
  const currentToken = processStartToken(identity.pid);
  return currentToken !== null && currentToken === identity.startToken;
}

function readLockOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(path.join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function removeStaleLock(lockDirectory) {
  let before;
  try {
    before = statSync(lockDirectory);
  } catch {
    return;
  }
  const owner = readLockOwner(lockDirectory);
  const stale = owner
    ? !processIdentityIsAlive(owner)
    : Date.now() - before.mtimeMs > EMPTY_LOCK_STALE_MS;
  if (!stale) return;
  try {
    const current = statSync(lockDirectory);
    if (current.ino === before.ino && current.dev === before.dev) {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  } catch {
    // Another hook may have released the lock after the first stat.
  }
}

function acquireLock(directory) {
  const lockDirectory = path.join(directory, ".state-lock");
  const lockId = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let created = false;
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      created = true;
      const ownerPath = path.join(lockDirectory, "owner.json");
      const owner = {
        pid: process.pid,
        startToken: processStartToken(process.pid),
        lockId,
        createdAt: Date.now(),
      };
      const descriptor = openSync(ownerPath, "wx", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(owner)}\n`, undefined, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { lockDirectory, lockId };
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (created) rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      removeStaleLock(lockDirectory);
      Atomics.wait(waitCell, 0, 0, LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for the private state lock");
}

function releaseLock(lock) {
  const owner = readLockOwner(lock.lockDirectory);
  if (owner?.pid === process.pid && owner.lockId === lock.lockId) {
    rmSync(lock.lockDirectory, { recursive: true, force: true });
  }
}

export function withLockedState(directory, update) {
  ensurePrivateDirectory(directory);
  const lock = acquireLock(directory);
  try {
    const state = readState(directory);
    const result = update(state);
    state.updatedAt = Date.now();
    writeState(directory, state);
    return { state, result };
  } finally {
    releaseLock(lock);
  }
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function newThread(threadId) {
  return {
    threadId,
    currentTurnId: null,
    active: false,
    waiting: null,
    stopHintTurnId: null,
    lastEvent: null,
    revision: 0,
    observation: "pending",
    observationFailureAt: null,
    subagents: Object.create(null),
  };
}

function isCurrentTurn(thread, turnId, eventName) {
  if (!validId(turnId)) return !thread.currentTurnId || !["Stop", "Interrupt", "PermissionRequest"].includes(eventName);
  return !thread.currentTurnId || thread.currentTurnId === turnId || eventName === "UserPromptSubmit";
}

export function applyHookEvent(state, event, now = Date.now()) {
  const eventName = event?.hook_event_name;
  const threadId = event?.session_id;
  if (!validId(threadId) || typeof eventName !== "string") return { changed: false, endedThread: false };
  state.threads = Object.assign(Object.create(null), state.threads);

  if (eventName === "SessionEnd") {
    const endedThread = Object.hasOwn(state.threads, threadId);
    delete state.threads[threadId];
    return { changed: endedThread, endedThread };
  }

  const knownEvents = new Set([
    "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
    "SubagentStart", "SubagentStop", "Stop", "Interrupt",
  ]);
  if (!knownEvents.has(eventName)) return { changed: false, endedThread: false };
  if (eventName === "SubagentStart" && !validId(event.agent_id)) {
    return { changed: false, endedThread: false };
  }

  let thread = state.threads[threadId];
  if (!thread && ["Stop", "Interrupt", "SubagentStop"].includes(eventName)) {
    return { changed: false, endedThread: false };
  }
  if (!thread) thread = state.threads[threadId] = newThread(threadId);
  thread.subagents = Object.assign(Object.create(null), thread.subagents ?? {});

  const turnId = validId(event.turn_id) ? event.turn_id : null;
  if (eventName === "SubagentStop") {
    const agentId = event.agent_id;
    if (!validId(agentId)) return { changed: false, endedThread: false };
    const subagent = thread.subagents[agentId];
    if (!subagent || (turnId && subagent.turnId && subagent.turnId !== turnId)) {
      return { changed: false, endedThread: false };
    }
    delete thread.subagents[agentId];
  } else {
    if (!isCurrentTurn(thread, turnId, eventName)) return { changed: false, endedThread: false };
    if (eventName === "UserPromptSubmit") {
      if (turnId) thread.currentTurnId = turnId;
      thread.active = true;
      thread.waiting = null;
      thread.stopHintTurnId = null;
    } else {
      if (!thread.currentTurnId && turnId) thread.currentTurnId = turnId;
      if (eventName === "PreToolUse" || eventName === "PostToolUse") {
        thread.active = true;
        thread.waiting = null;
        thread.stopHintTurnId = null;
      } else if (eventName === "PermissionRequest") {
        thread.active = false;
        thread.waiting = "approval";
      } else if (eventName === "SubagentStart") {
        if (!validId(event.agent_id)) return { changed: false, endedThread: false };
        thread.subagents[event.agent_id] = {
          turnId: turnId ?? thread.currentTurnId,
          active: true,
          startedAt: now,
        };
        thread.active = true;
        thread.waiting = null;
      } else if (eventName === "Stop") {
        thread.active = false;
        thread.waiting = "user_input";
        thread.stopHintTurnId = turnId ?? thread.currentTurnId;
      } else if (eventName === "Interrupt") {
        thread.active = false;
        thread.waiting = null;
        thread.stopHintTurnId = turnId ?? thread.currentTurnId;
      }
    }
  }

  thread.revision += 1;
  thread.lastEvent = { name: eventName, turnId, at: now };
  return { changed: true, endedThread: false };
}
