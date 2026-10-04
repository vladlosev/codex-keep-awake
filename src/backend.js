import { spawn } from "node:child_process";
import path from "node:path";

export const GNOME_APP_ID = "org.openai.Codex.KeepAwake";
export const GNOME_REASON = "Codex is running active work";
export const LEASE_READY_LINE = "CODEX_KEEP_AWAKE_LEASE_READY";

export class GnomeInhibitorBackend {
  constructor({
    command = "gnome-session-inhibit",
    spawnProcess = spawn,
    nodePath = process.execPath,
    scriptPath,
    dataDirectory,
  }) {
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.nodePath = nodePath;
    this.scriptPath = scriptPath;
    this.dataDirectory = dataDirectory;
    this.required = false;
    this.child = null;
    this.active = false;
    this.error = null;
    this.retryAt = 0;
  }

  acquire() {
    if (this.child || this.error) return;
    if (process.platform !== "linux") {
      this.error = "GNOME inhibition is only available on Linux";
      this.retryAt = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (!this.scriptPath || !this.dataDirectory) {
      this.error = "The GNOME lease command is not configured";
      return;
    }

    let child;
    try {
      child = this.spawnProcess(this.command, [
      "--app-id", GNOME_APP_ID,
      "--inhibit", "suspend",
      "--reason", GNOME_REASON,
      this.nodePath,
      this.scriptPath,
      "lease",
      "--data-dir", this.dataDirectory,
      ], {
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
        ? "The GNOME inhibitor exited while protection was still required"
        : `The GNOME inhibitor exited (${signal ?? `status ${code}`})`;
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
