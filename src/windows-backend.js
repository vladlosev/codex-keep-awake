import { StdinLeaseBackend } from "./lease-backend.js";

export class WindowsExecutionStateBackend extends StdinLeaseBackend {
  constructor({
    command = "powershell.exe",
    helperScriptPath,
    spawnProcess,
    platform = process.platform,
  } = {}) {
    super({
      command,
      args: helperScriptPath
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperScriptPath]
        : [],
      spawnProcess,
      platform,
      supportedPlatform: "win32",
      unsupportedMessage: "Windows execution-state inhibition is only available on Windows",
      configurationError: helperScriptPath ? null : "The Windows keep-awake helper is not configured",
      leaseName: "The Windows execution-state lease",
    });
    this.helperScriptPath = helperScriptPath;
  }
}
