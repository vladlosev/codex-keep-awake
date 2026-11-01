import { createRequire } from "node:module";
import { acquirePortalInhibitor } from "./portal-inhibitor.js";

const require = createRequire(import.meta.url);
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 5000;

export const PORTAL_BACKEND_ID = "xdg-desktop-portal";
export const CODEX_PORTAL_REASON = "Codex is running active work";
export { acquirePortalInhibitor };

export class PortalInhibitorBackend {
  constructor({
    dbus,
    reason,
    platform = process.platform,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    acquisitionTimeoutMs = DEFAULT_ACQUISITION_TIMEOUT_MS,
  } = {}) {
    this.dbus = dbus;
    this.reason = reason;
    this.platform = platform;
    this.retryDelayMs = retryDelayMs;
    this.acquisitionTimeoutMs = acquisitionTimeoutMs;
    this.backend = PORTAL_BACKEND_ID;
    this.required = false;
    this.active = false;
    this.error = null;
    this.lease = null;
    this.acquiring = null;
    this.acquisitionController = null;
    this.retryAt = 0;
    this.retryTimer = null;
    this.statusListeners = new Set();
    this.generation = 0;
    this.closed = false;
    this.closePromise = null;
  }

  subscribeStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("Status listener must be a function");
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  notifyStatus() {
    const status = this.status();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // A status observer must not interfere with acquisition or cleanup.
      }
    }
  }

  scheduleRetry() {
    if (!this.required || this.closed || this.retryTimer) return;
    this.retryAt = Date.now() + this.retryDelayMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = 0;
      if (this.required && !this.closed) this.acquire();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
    this.notifyStatus();
  }

  acquire() {
    if (this.closed || !this.required || this.acquiring || this.lease || this.retryTimer) return;
    if (this.platform !== "linux") {
      this.error = "The XDG Desktop Portal suspend inhibitor is only available on Linux";
      this.retryAt = Number.MAX_SAFE_INTEGER;
      this.notifyStatus();
      return;
    }
    if (typeof this.reason !== "string" || !this.reason) {
      this.error = "The XDG Desktop Portal suspend inhibitor is unavailable";
      this.retryAt = Number.MAX_SAFE_INTEGER;
      this.notifyStatus();
      return;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.acquisitionController = controller;
    this.error = null;
    this.notifyStatus();

    const acquiring = Promise.resolve().then(() => acquirePortalInhibitor({
      dbus: this.dbus ??= require("dbus-native"),
      reason: this.reason,
      signal: controller.signal,
      timeoutMs: this.acquisitionTimeoutMs,
    }));
    this.acquiring = acquiring;
    void acquiring.then((lease) => {
      if (this.closed || !this.required || generation !== this.generation) {
        return lease.release();
      }
      this.lease = lease;
      this.active = true;
      this.error = null;
      this.notifyStatus();
      void lease.lost.then(
        (error) => this.loseLease(lease, generation, error),
        (error) => this.loseLease(lease, generation, error),
      );
    }, (error) => {
      if (this.closed || !this.required || generation !== this.generation || controller.signal.aborted) return;
      this.active = false;
      this.error = error instanceof Error ? error.message : "The XDG Desktop Portal suspend inhibitor is unavailable";
      this.scheduleRetry();
    }).finally(() => {
      if (this.acquiring === acquiring) this.acquiring = null;
      if (this.acquisitionController === controller) this.acquisitionController = null;
      if (this.required && !this.closed && !this.active && generation !== this.generation && !this.retryTimer) {
        this.acquire();
      }
    });
  }

  loseLease(lease, generation, error) {
    if (this.lease !== lease) return;
    this.lease = null;
    this.active = false;
    if (this.required && !this.closed && generation === this.generation) {
      this.error = error instanceof Error ? error.message : "The XDG Desktop Portal suspend inhibitor is unavailable";
      this.scheduleRetry();
    } else {
      this.error = null;
    }
    this.notifyStatus();
    void lease.release();
  }

  setRequired(required) {
    if (this.closed) return;
    if (!required) {
      this.release();
      return;
    }
    this.required = true;
    if (this.active || this.acquiring || this.retryTimer || this.retryAt === Number.MAX_SAFE_INTEGER) {
      this.notifyStatus();
      return;
    }
    if (Date.now() < this.retryAt) return;
    this.acquire();
  }

  release() {
    this.required = false;
    this.generation += 1;
    this.active = false;
    this.error = null;
    this.retryAt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.acquisitionController?.abort();
    const lease = this.lease;
    this.lease = null;
    this.notifyStatus();
    return lease?.release() ?? Promise.resolve();
  }

  status() {
    return {
      required: this.required,
      active: this.active,
      error: this.error,
      command: null,
    };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const acquiring = this.acquiring;
    const releasing = this.release();
    this.closePromise = Promise.allSettled([acquiring, releasing]).then(() => undefined);
    return this.closePromise;
  }
}
