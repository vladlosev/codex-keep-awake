import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerObserver } from "./app-server-observer.js";
import { GnomeInhibitorBackend } from "./backend.js";
import {
  processIdentityIsAlive,
  processStartToken,
  readState,
  withLockedState,
} from "./state.js";

const READ_INTERVAL_MS = 1000;
const CONNECT_RETRY_MS = 2000;
export const FAILURE_RELEASE_MS = 60_000;
const leaseScriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "lease.js");

let stopped = false;
let timer = null;
let instanceId = null;
let dataDirectory = null;
let observer = null;
let backend = null;
let tickInProgress = false;
let nextConnectAttempt = 0;
let lastObserverError = null;
let startupGraceUntil = 0;
let observerEverConnected = false;

function ownsState(state) {
  return state.supervisor?.pid === process.pid
    && state.supervisor.instanceId === instanceId
    && state.supervisor.startToken === processStartToken(process.pid);
}

function hasActiveSubagent(thread) {
  return Object.values(thread.subagents ?? {}).some((agent) => agent.active);
}

function hookFallbackRequiresProtection(thread, now) {
  if (thread.observation === "observed") return false;
  if (thread.observationFailureAt && now - thread.observationFailureAt >= FAILURE_RELEASE_MS) return false;
  return thread.active || hasActiveSubagent(thread);
}

export function requiredByState(state, now = Date.now()) {
  return Object.values(state.threads).some((thread) => {
    if (thread.observation === "observed") return thread.active || hasActiveSubagent(thread);
    return hookFallbackRequiresProtection(thread, now);
  });
}

function failureMessage(error) {
  if (error instanceof Error && error.name === "RpcError") return "A registered thread is not observable in the Codex app-server";
  return "Could not read Codex app-server state; hook-based turn tracking is active";
}

function normalizeWait(flags) {
  if (flags.includes("waitingOnApproval")) return "approval";
  if (flags.includes("waitingOnUserInput")) return "user_input";
  return null;
}

function applyObservedStatuses(state, snapshots, observations, now, observerWasConnected) {
  const results = new Map(observations.map((observation) => [observation.threadId, observation]));
  let hasUnobservableThread = false;
  for (const snapshot of snapshots) {
    const thread = state.threads[snapshot.threadId];
    if (!thread || thread.revision !== snapshot.revision) continue;
    const observation = results.get(snapshot.threadId);
    if (!observation || observation.rpcError) {
      thread.observation = "unavailable";
      if (observerWasConnected) thread.observationFailureAt ??= now;
      hasUnobservableThread = true;
      continue;
    }

    const status = observation.status;
    if (status.type === "idle" || status.type === "notLoaded" || status.type === "systemError") {
      delete state.threads[snapshot.threadId];
      continue;
    }
    if (status.type !== "active") {
      thread.observation = "unavailable";
      if (observerWasConnected) thread.observationFailureAt ??= now;
      hasUnobservableThread = true;
      continue;
    }

    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    thread.observation = "observed";
    thread.observationFailureAt = null;
    thread.waiting = normalizeWait(flags);
    thread.active = thread.waiting === null;
  }
  return hasUnobservableThread;
}

function recordRuntime({ connected, required, backendStatus, now }) {
  let lostOwnership = false;
  let hasThreads = false;
  try {
    withLockedState(dataDirectory, (state) => {
      if (!ownsState(state)) {
        lostOwnership = true;
        return;
      }
      hasThreads = Object.keys(state.threads).length > 0;
      if (!hasThreads) {
        state.runtime = null;
        return;
      }
      const unavailable = Object.values(state.threads).some((thread) => thread.observation !== "observed");
      let degradedReason = null;
      if (unavailable) degradedReason = connected ? "thread_unobservable" : "app_server_unavailable";
      else if (backendStatus.error) degradedReason = "gnome_inhibitor_unavailable";
      state.runtime = {
        appServerConnected: connected,
        automaticPauseResume: connected && !unavailable,
        degradedReason,
        observationMessage: unavailable
          ? lastObserverError ?? "Codex app-server state is unavailable; hook-based turn tracking is active. Automatic pause/resume during waits is unavailable."
          : null,
        protectionRequired: required,
        inhibitionActive: backendStatus.active,
        backendError: backendStatus.error,
        updatedAt: now,
      };
    });
  } catch {
    // State updates are advisory; the next poll retries the atomic write.
  }
  return { lostOwnership, hasThreads };
}

function finish() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  backend?.close();
  observer?.close();
  try {
    withLockedState(dataDirectory, (state) => {
      if (ownsState(state)) {
        state.supervisor = null;
        state.runtime = null;
      }
    });
  } catch {
    // The next hook repairs an unowned or stale supervisor record.
  }
  process.exit(0);
}

async function tick() {
  if (stopped || tickInProgress) return;
  tickInProgress = true;
  const now = Date.now();
  try {
    let state = readState(dataDirectory);
    if (!ownsState(state) && Date.now() < startupGraceUntil
      && (!state.supervisor || state.supervisor.pid === process.pid)) {
      return;
    }
    if (!ownsState(state) || Object.keys(state.threads).length === 0
      || !processIdentityIsAlive(state.supervisor)) {
      finish();
      return;
    }

    // Hooks give immediate protection while the observer connects. Once the
    // app-server responds, its read-only thread status becomes authoritative.
    backend.setRequired(requiredByState(state, now));
    const snapshots = Object.values(state.threads).map((thread) => ({
      threadId: thread.threadId,
      revision: thread.revision,
    }));

    let observations = null;
    if (!observer.connected && now >= nextConnectAttempt) {
      nextConnectAttempt = now + CONNECT_RETRY_MS;
      try {
        await observer.connect();
        observerEverConnected = true;
        lastObserverError = null;
      } catch (error) {
        lastObserverError = failureMessage(error);
        observer.close();
      }
    }
    if (observer.connected) {
      try {
        observations = await observer.readThreads(snapshots.map((snapshot) => snapshot.threadId));
        lastObserverError = null;
      } catch (error) {
        lastObserverError = failureMessage(error);
        observer.close();
        nextConnectAttempt = Date.now() + CONNECT_RETRY_MS;
      }
    }

    if (observations) {
      withLockedState(dataDirectory, (currentState) => {
        if (!ownsState(currentState)) return;
        const partial = applyObservedStatuses(currentState, snapshots, observations, Date.now(), observerEverConnected);
        lastObserverError = partial ? "A registered thread is not observable in the Codex app-server" : null;
        state = currentState;
      });
    } else {
      withLockedState(dataDirectory, (currentState) => {
        if (!ownsState(currentState)) return;
        for (const snapshot of snapshots) {
          const thread = currentState.threads[snapshot.threadId];
          if (!thread || thread.revision !== snapshot.revision) continue;
          thread.observation = "unavailable";
          // A daemonless session is expected to use hooks for its whole turn.
          // Start the 60-second fail-safe only after this supervisor connected
          // to an observer and then lost reliable state.
          if (observerEverConnected) thread.observationFailureAt ??= Date.now();
        }
        state = currentState;
      });
    }

    state = readState(dataDirectory);
    const required = requiredByState(state, Date.now());
    backend.setRequired(required);
    const backendStatus = backend.status();
    const result = recordRuntime({
      connected: Boolean(observations),
      required,
      backendStatus,
      now: Date.now(),
    });
    if (result.lostOwnership || !result.hasThreads) finish();
  } catch {
    lastObserverError = "Codex Keep Awake could not refresh its private runtime state";
    const state = readState(dataDirectory);
    const required = requiredByState(state, Date.now());
    backend.setRequired(required);
    const backendStatus = backend.status();
    recordRuntime({
      connected: observer.connected,
      required,
      backendStatus,
      now: Date.now(),
    });
  } finally {
    tickInProgress = false;
  }
}

export function runSupervisor(directory, id, options = {}) {
  dataDirectory = directory;
  instanceId = id;
  startupGraceUntil = Date.now() + 1000;
  observer = options.observer ?? new AppServerObserver(options.observerOptions);
  backend = options.backend ?? new GnomeInhibitorBackend({
    command: options.inhibitorCommand ?? process.env.CODEX_KEEP_AWAKE_GNOME_INHIBITOR ?? "gnome-session-inhibit",
    spawnProcess: options.spawnProcess,
    nodePath: process.execPath,
    leaseScriptPath,
  });
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  process.on("SIGHUP", finish);
  void tick();
  timer = setInterval(() => { void tick(); }, READ_INTERVAL_MS);
}
