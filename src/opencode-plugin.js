import { OpenCodeActivityTracker } from "./opencode-activity.js";

export function createOpenCodeHooks({ backend, activity = new OpenCodeActivityTracker(), warn = console.warn }) {
  let lastRequired = false;
  let lastError = null;

  function reportBackendError() {
    const error = backend.status().error;
    if (error && error !== lastError) {
      warn(`[Codex Keep Awake] OpenCode inhibition is unavailable: ${error}`);
      lastError = error;
    } else if (!error) {
      lastError = null;
    }
  }

  return {
    event({ event }) {
      try {
        const required = activity.handle(event);
        const retrying = required && Boolean(backend.status().error);
        if (required !== lastRequired || retrying) {
          backend.setRequired(required);
          lastRequired = required;
        }
        reportBackendError();
      } catch {
        warn("[Codex Keep Awake] OpenCode event handling failed; no event content was logged.");
      }
    },
    dispose() {
      try {
        backend.close();
      } catch {
        warn("[Codex Keep Awake] Could not close the OpenCode inhibitor lease.");
      }
    },
  };
}
