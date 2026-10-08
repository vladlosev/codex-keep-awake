import { StdinLeaseBackend } from "./lease-backend.js";

export const GNOME_APP_ID = "org.openai.Codex.KeepAwake";
export const GNOME_REASON = "Codex is running active work";
export { LEASE_READY_LINE } from "./lease.js";

export class GnomeInhibitorBackend extends StdinLeaseBackend {
  constructor({
    command = "gnome-session-inhibit",
    spawnProcess,
    nodePath = process.execPath,
    leaseScriptPath,
    appId = GNOME_APP_ID,
    reason = GNOME_REASON,
    platform = process.platform,
  }) {
    super({
      command,
      args: [
        "--app-id", appId,
        "--inhibit", "suspend",
        "--reason", reason,
        nodePath,
        ...(leaseScriptPath ? [leaseScriptPath] : []),
      ],
      spawnProcess,
      platform,
      supportedPlatform: "linux",
      unsupportedMessage: "GNOME inhibition is only available on Linux",
      configurationError: leaseScriptPath ? null : "The GNOME lease command is not configured",
      leaseName: "The GNOME inhibitor",
    });
    this.appId = appId;
    this.reason = reason;
  }
}
