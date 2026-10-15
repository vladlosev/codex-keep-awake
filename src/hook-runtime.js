import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyHookEvent,
  processIdentityIsAlive,
  processStartToken,
  withLockedState,
} from "./state.js";

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function launchSupervisor(dataDirectory, pluginRoot) {
  const instanceId = randomUUID();
  const scriptPath = path.join(pluginRoot, "scripts", "codex-keep-awake.js");
  const child = spawn(process.execPath, [scriptPath, "supervisor", "--data-dir", dataDirectory], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: dataDirectory,
      CODEX_KEEP_AWAKE_SUPERVISOR_ID: instanceId,
    },
  });
  child.on("error", () => {});
  child.unref();

  let startToken = null;
  for (let attempt = 0; attempt < 10 && !startToken; attempt += 1) {
    startToken = processStartToken(child.pid);
    if (!startToken) Atomics.wait(waitCell, 0, 0, 10);
  }
  return {
    pid: child.pid,
    startToken,
    instanceId,
    startedAt: Date.now(),
  };
}

function signalOwnedSupervisor(supervisor) {
  if (!processIdentityIsAlive(supervisor)) return false;
  try {
    process.kill(supervisor.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function handleHook(dataDirectory, pluginRoot, event) {
  let supervisorToStop = null;
  const { state } = withLockedState(dataDirectory, (currentState) => {
    const update = applyHookEvent(currentState, event);
    if (Object.keys(currentState.threads).length === 0) {
      if (currentState.supervisor) supervisorToStop = currentState.supervisor;
      currentState.supervisor = null;
      currentState.runtime = null;
      return update;
    }

    if (!processIdentityIsAlive(currentState.supervisor)) {
      currentState.supervisor = launchSupervisor(dataDirectory, pluginRoot);
    }
    return update;
  });

  if (supervisorToStop) signalOwnedSupervisor(supervisorToStop);
  return state;
}

export function stopOwnedSupervisor(supervisor) {
  return signalOwnedSupervisor(supervisor);
}
