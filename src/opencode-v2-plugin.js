import path from "node:path";
import { createOpenCodeHooks } from "./opencode-plugin.js";
import { normalizeOpenCodeV2Event } from "./opencode-v2-events.js";

const observationWarning = "[Codex Keep Awake] OpenCode V2 observation stopped; reload the plugin to resume protection.";
const validID = (id) => typeof id === "string" && id.length > 0 && id !== "global";
const sameLocation = (a, b) => typeof a?.directory === "string" && typeof b?.directory === "string"
  && path.resolve(a.directory) === path.resolve(b.directory)
  && (a.workspaceID ?? null) === (b.workspaceID ?? null);

async function readSession(ctx, id, signal) {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    // V2's in-process Promise context may ignore the HTTP client's signal argument.
    return await Promise.race([
      Promise.resolve().then(() => ctx.session.get({ sessionID: id }, { signal })),
      cancelled.promise,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function setupOpenCodeV2(ctx, { backend, activity, warn = console.warn }) {
  const controller = new AbortController();
  const hooks = createOpenCodeHooks({ backend, activity, warn });
  const sessions = new Map();
  let disposed = false;

  function cleanup() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    sessions.clear();
    hooks.dispose();
  }

  function remove(id) {
    const removed = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const session of sessions.values()) {
        if (!removed.has(session.id) && removed.has(session.parentID)) {
          removed.add(session.id);
          changed = true;
        }
      }
    }
    for (const sessionID of removed) sessions.delete(sessionID);
    hooks.event({ event: { type: "session.deleted", properties: { sessionID: id } } });
  }

  async function ensureSession(id, signal, seed, ancestors = new Set()) {
    if (sessions.has(id)) return true;
    if (ancestors.has(id)) throw new Error("Invalid session ancestry");
    ancestors.add(id);
    const info = seed ?? await readSession(ctx, id, signal);
    signal.throwIfAborted();
    if (info?.id !== id) throw new Error("Invalid session metadata");
    if (!sameLocation(info.location, ctx.location)) return false;
    const parentID = info.parentID ?? null;
    if (parentID !== null && !validID(parentID)) throw new Error("Invalid session parent");
    if (parentID && !await ensureSession(parentID, signal, undefined, ancestors)) return false;
    signal.throwIfAborted();
    sessions.set(id, {
      id, parentID,
      location: { directory: info.location.directory, workspaceID: info.location.workspaceID },
    });
    hooks.event({ event: { type: "session.updated", properties: { info: { id, parentID } } } });
    return true;
  }

  async function observe() {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (disposed) break;
        const mapped = normalizeOpenCodeV2Event(event);
        const moved = event?.type === "session.moved" && validID(event.data?.sessionID);
        if (!mapped && !moved) continue;
        const id = moved ? event.data.sessionID : mapped.properties.info?.id ?? mapped.properties.sessionID;
        const known = sessions.has(id);
        const starts = mapped && (mapped.type === "session.created"
          || mapped.type === "permission.asked" || mapped.type === "question.asked"
          || (mapped.type === "session.status" && mapped.properties.status.type !== "idle"));
        if (!known && !starts) continue;

        if (event.location && !sameLocation(event.location, ctx.location)) {
          if (known) remove(id);
          continue;
        }
        const creation = mapped?.type === "session.created" && event.data.location;
        if (creation && !sameLocation(creation, ctx.location)) {
          if (known) remove(id);
          continue;
        }
        if (moved) sessions.delete(id);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]);
        try {
          const seed = creation ? { ...mapped.properties.info, location: creation } : undefined;
          if (!await ensureSession(id, signal, seed)) {
            if (known) remove(id);
            continue;
          }
        } catch (error) {
          if (error?._tag !== "SessionNotFoundError") throw error;
          remove(id);
          continue;
        }
        if (disposed) break;
        if (mapped?.type === "session.deleted") remove(id);
        else if (mapped) hooks.event({ event: mapped });
      }
      if (!disposed) warn(observationWarning);
    } catch {
      if (!disposed) warn(observationWarning);
    } finally {
      cleanup();
    }
  }

  // Cleanup releases the lease immediately, even if a broken transport ignores abort.
  void observe().catch(() => cleanup());
  return cleanup;
}
