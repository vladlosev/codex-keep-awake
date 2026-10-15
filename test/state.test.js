import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FAILURE_RELEASE_MS, requiredByState } from "../src/supervisor.js";
import {
  applyHookEvent,
  defaultState,
  processIdentityIsAlive,
  processStartToken,
  readState,
  withLockedState,
} from "../src/state.js";

test("turns, waits, subagents, interruptions, and Stop continuation stay scoped to their identities", () => {
  const state = defaultState();
  const event = (hook_event_name, turn_id, additional = {}) => ({
    hook_event_name,
    session_id: "thread-a",
    turn_id,
    prompt: "private prompt should never be recorded",
    command: "private command should never be recorded",
    ...additional,
  });

  applyHookEvent(state, event("UserPromptSubmit", "turn-a"), 1);
  assert.equal(state.threads["thread-a"].active, true);
  applyHookEvent(state, event("PermissionRequest", "turn-a"), 2);
  assert.equal(state.threads["thread-a"].waiting, "approval");
  assert.equal(state.threads["thread-a"].active, false);
  applyHookEvent(state, event("PreToolUse", "turn-a"), 3);
  assert.equal(state.threads["thread-a"].active, true);
  assert.equal(state.threads["thread-a"].waiting, null);

  applyHookEvent(state, event("SubagentStart", "turn-a", { agent_id: "agent-1", agent_type: "worker" }), 4);
  applyHookEvent(state, event("SubagentStart", "turn-a", { agent_id: "agent-2", agent_type: "reviewer" }), 5);
  assert.equal(Object.keys(state.threads["thread-a"].subagents).length, 2);
  applyHookEvent(state, event("Stop", "turn-a"), 6);
  assert.equal(state.threads["thread-a"].waiting, "user_input");
  assert.equal(state.threads["thread-a"].active, false);

  // A continuation tool hook clears the Stop hint before the next Stop arrives.
  applyHookEvent(state, event("PreToolUse", "turn-a"), 7);
  assert.equal(state.threads["thread-a"].active, true);
  assert.equal(state.threads["thread-a"].stopHintTurnId, null);

  applyHookEvent(state, event("Interrupt", "turn-a"), 8);
  assert.equal(state.threads["thread-a"].active, false);
  assert.equal(state.threads["thread-a"].waiting, null);
  applyHookEvent(state, event("UserPromptSubmit", "turn-b"), 9);
  assert.equal(state.threads["thread-a"].currentTurnId, "turn-b");
  applyHookEvent(state, event("SubagentStart", "turn-b", { agent_id: "agent-3" }), 10);
  applyHookEvent(state, event("SubagentStart", "turn-b", { agent_id: "agent-3" }), 10);
  assert.equal(Object.keys(state.threads["thread-a"].subagents).filter((id) => id === "agent-3").length, 1);

  const staleStop = applyHookEvent(state, event("Stop", "turn-a"), 11);
  const staleAgentStop = applyHookEvent(state, event("SubagentStop", "turn-a", { agent_id: "agent-3" }), 12);
  assert.equal(staleStop.changed, false);
  assert.equal(staleAgentStop.changed, false);
  assert.equal(state.threads["thread-a"].active, true);
  assert.equal(state.threads["thread-a"].subagents["agent-3"].turnId, "turn-b");
  assert.equal(JSON.stringify(state).includes("private prompt"), false);
  assert.equal(JSON.stringify(state).includes("private command"), false);

  applyHookEvent(state, event("SessionEnd", "turn-b"), 13);
  assert.equal(Object.hasOwn(state.threads, "thread-a"), false);
});

test("private state recovers stale locks and retains owner-only permissions", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-keep-awake-lock-"));
  const staleLock = path.join(dataDir, ".state-lock");
  try {
    await mkdir(staleLock);
    await writeFile(path.join(staleLock, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      startToken: "old-process-start",
      lockId: "stale-lock",
    }), { mode: 0o600 });

    const { state } = withLockedState(dataDir, (current) => {
      current.threads["thread-safe"] = { threadId: "thread-safe", active: false, subagents: {} };
    });
    assert.equal(state.threads["thread-safe"].active, false);
    assert.equal(readState(dataDir).threads["thread-safe"].threadId, "thread-safe");
    assert.equal((statSync(dataDir).mode & 0o777), 0o700);
    assert.equal((statSync(path.join(dataDir, "state.json")).mode & 0o777), 0o600);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("process start tokens reject a reused PID and accept its current owner", () => {
  const token = processStartToken(process.pid);
  assert.equal(typeof token, "string");
  assert.equal(processIdentityIsAlive({ pid: process.pid, startToken: token }), true);
  assert.equal(processIdentityIsAlive({ pid: process.pid, startToken: "different-start-token" }), false);
  assert.equal(processIdentityIsAlive({ pid: process.pid, startToken: null }), false);
  assert.equal(processIdentityIsAlive({ pid: 2_147_483_647, startToken: "old-process-start" }), false);
});

test("lost observation releases after sixty seconds while daemonless hook fallback continues", () => {
  const now = Date.now();
  const state = {
    threads: {
      "thread-live": {
        observation: "unavailable",
        observationFailureAt: now - FAILURE_RELEASE_MS + 1,
        active: true,
        subagents: {},
      },
    },
  };
  assert.equal(requiredByState(state, now), true);
  state.threads["thread-live"].observationFailureAt = now - FAILURE_RELEASE_MS;
  assert.equal(requiredByState(state, now), false);
  state.threads["thread-live"].observationFailureAt = null;
  assert.equal(requiredByState(state, now + (FAILURE_RELEASE_MS * 3)), true);
});

