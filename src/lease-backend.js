import { spawn } from "node:child_process";
import path from "node:path";
import { LEASE_READY_LINE } from "./lease.js";

const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_READINESS_TIMEOUT_MS = 6000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2000;

export class StdinLeaseBackend {
  constructor({
    command,
    args,
    spawnProcess = spawn,
    platform = process.platform,
    supportedPlatform,
    unsupportedMessage,
    configurationError = null,
    leaseName = "inhibitor",
    failureMessage = `${leaseName} is unavailable`,
    startErrorMessage = `${leaseName} could not start`,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    teardownTimeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS,
  }) {
    this.command = command;
    this.args = args;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.supportedPlatform = supportedPlatform;
    this.unsupportedMessage = unsupportedMessage;
    this.configurationError = configurationError;
    this.leaseName = leaseName;
    this.failureMessage = failureMessage;
    this.startErrorMessage = startErrorMessage;
    this.retryDelayMs = retryDelayMs;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.teardownTimeoutMs = teardownTimeoutMs;
    this.required = false;
    this.child = null;
    this.active = false;
    this.error = null;
    this.retryAt = 0;
    this.retryTimer = null;
    this.readinessTimer = null;
    this.statusListeners = new Set();
    this.closed = false;
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

  clearReadinessTimer() {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  scheduleRetry() {
    if (!this.required || this.closed || this.retryTimer) return;
    this.retryAt = Date.now() + this.retryDelayMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = 0;
      if (this.required && !this.closed) this.acquire();
    }, this.retryDelayMs);
    this.notifyStatus();
  }

  terminate(child) {
    if (!child) return;
    try {
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    } catch {
      // The process may have exited between the state check and stdin close.
    }

    let exited = child.exitCode != null || child.signalCode != null;
    let timer = null;
    const finish = () => {
      exited = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", finish);
      child.removeListener("close", finish);
    };
    if (exited) return;
    child.once("exit", finish);
    child.once("close", finish);
    timer = setTimeout(() => {
      if (exited) return;
      try {
        child.kill(this.platform === "win32" ? "SIGTERM" : "SIGKILL");
      } catch {
        // Cleanup has already dropped the parent's reference to this child.
      }
    }, this.teardownTimeoutMs);
  }

  fail(child, message) {
    if (child && this.child !== child) return;
    if (child) this.child = null;
    this.clearReadinessTimer();
    this.active = false;
    this.error = message;
    this.notifyStatus();
    if (child) this.terminate(child);
    this.scheduleRetry();
  }

  acquire() {
    if (this.closed || !this.required || this.child) return;
    if (this.platform !== this.supportedPlatform) {
      this.error = this.unsupportedMessage;
      this.retryAt = Number.MAX_SAFE_INTEGER;
      this.notifyStatus();
      return;
    }
    if (this.configurationError) {
      this.error = this.configurationError;
      this.retryAt = Number.MAX_SAFE_INTEGER;
      this.notifyStatus();
      return;
    }

    let child;
    try {
      child = this.spawnProcess(this.command, this.args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      this.fail(null, this.startErrorMessage);
      return;
    }
    this.child = child;
    this.active = false;
    this.error = null;
    this.notifyStatus();
    let output = "";
    this.readinessTimer = setTimeout(() => {
      if (this.child === child && this.required && !this.active) {
        this.fail(child, this.failureMessage);
      }
    }, this.readinessTimeoutMs);

    child.once("spawn", () => {
      if (this.child === child && this.required) this.notifyStatus();
    });
    if (child.stdout) {
      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-256);
        if (output.split(/\r?\n/).includes(LEASE_READY_LINE) && this.child === child && this.required) {
          this.clearReadinessTimer();
          this.active = true;
          this.error = null;
          this.notifyStatus();
        }
      });
    }
    child.once("error", () => {
      this.fail(child, this.startErrorMessage);
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.clearReadinessTimer();
      this.active = false;
      if (this.required && !this.closed) {
        this.error = this.failureMessage;
        this.scheduleRetry();
      }
      this.notifyStatus();
    });
  }

  setRequired(required) {
    const next = Boolean(required);
    if (this.closed) return;
    if (!next) {
      this.release();
      return;
    }
    this.required = true;
    if (this.child || this.retryTimer) {
      this.notifyStatus();
      return;
    }
    if (Date.now() < this.retryAt) {
      this.scheduleRetry();
      return;
    }
    this.error = null;
    this.acquire();
  }

  release() {
    this.required = false;
    this.active = false;
    this.error = null;
    this.retryAt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearReadinessTimer();
    const child = this.child;
    this.child = null;
    if (child) this.terminate(child);
    this.notifyStatus();
  }

  status() {
    return {
      required: this.required,
      active: this.active,
      error: this.error,
      command: this.child ? path.basename(this.command) : null,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }
}
