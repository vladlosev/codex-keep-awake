import { spawn } from "node:child_process";
import path from "node:path";
import { LEASE_READY_LINE } from "./lease.js";

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
  }) {
    this.command = command;
    this.args = args;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.supportedPlatform = supportedPlatform;
    this.unsupportedMessage = unsupportedMessage;
    this.configurationError = configurationError;
    this.leaseName = leaseName;
    this.required = false;
    this.child = null;
    this.active = false;
    this.error = null;
    this.retryAt = 0;
  }

  acquire() {
    if (this.child || this.error) return;
    if (this.platform !== this.supportedPlatform) {
      this.error = this.unsupportedMessage;
      this.retryAt = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (this.configurationError) {
      this.error = this.configurationError;
      this.retryAt = Number.MAX_SAFE_INTEGER;
      return;
    }

    let child;
    try {
      child = this.spawnProcess(this.command, this.args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      this.error = error.message;
      this.retryAt = Date.now() + 5000;
      return;
    }
    this.child = child;
    child.once("spawn", () => {
      if (this.child === child && this.required) this.error = null;
    });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-256);
      if (output.split(/\r?\n/).includes(LEASE_READY_LINE) && this.child === child && this.required) {
        this.active = true;
        this.error = null;
      }
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.active = false;
      this.error = error.message;
      this.retryAt = Date.now() + 5000;
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.active = false;
      if (this.required) {
        this.error = code === 0
          ? `${this.leaseName} exited while protection was still required`
          : `${this.leaseName} exited (${signal ?? `status ${code}`})`;
        this.retryAt = Date.now() + 5000;
      }
    });
  }

  setRequired(required) {
    const next = Boolean(required);
    if (!next) {
      this.release();
      return;
    }
    this.required = true;
    if (this.child || Date.now() < this.retryAt) return;
    this.error = null;
    this.acquire();
  }

  release() {
    this.required = false;
    this.active = false;
    const child = this.child;
    this.child = null;
    this.error = null;
    this.retryAt = 0;
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
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
    this.release();
  }
}
