import path from "node:path";
import { fileURLToPath } from "node:url";
import { GnomeInhibitorBackend } from "./backend.js";
import { WindowsExecutionStateBackend } from "./windows-backend.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createOpenCodeBackend(platform = process.platform, options = {}) {
  if (platform === "linux") {
    return new GnomeInhibitorBackend({
      nodePath: "node",
      leaseScriptPath: path.join(sourceDirectory, "lease.js"),
      appId: "org.opencode.KeepAwake",
      reason: "OpenCode is running active work",
      platform,
      ...options,
    });
  }
  if (platform === "win32") {
    return new WindowsExecutionStateBackend({
      helperScriptPath: path.join(sourceDirectory, "windows-keep-awake.ps1"),
      platform,
      ...options,
    });
  }
  return null;
}
