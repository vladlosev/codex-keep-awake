import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginName = "codex-keep-awake";
const pluginId = `${pluginName}@${pluginName}`;

export function runInstalledPluginCommand(command) {
  const listed = spawnSync("codex", [
    "plugin", "list", "--marketplace", pluginName, "--json",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error("Could not list installed Codex plugins. Check that codex is on PATH and codex plugin list --json succeeds.");
  }

  let installed;
  try {
    ({ installed } = JSON.parse(listed.stdout));
    if (!Array.isArray(installed)) throw new Error();
  } catch {
    throw new Error("Codex returned an invalid plugin list. Check codex plugin list --json.");
  }
  const plugin = installed.find((entry) => entry.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`The plugin is not installed. Run codex plugin add ${pluginId} first.`);
  }
  if (typeof plugin.version !== "string" || !plugin.version) {
    throw new Error(`The installed plugin version is unavailable. Reinstall ${pluginId}.`);
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const script = path.join(codexHome, "plugins", "cache", pluginName, pluginName, plugin.version, "scripts", "codex-keep-awake.js");
  if (!existsSync(script)) {
    throw new Error(`The installed plugin script is missing. Reinstall ${pluginId}.`);
  }
  const dataDirectory = path.join(codexHome, "plugins", "data", `${pluginName}-${pluginName}`);
  const result = spawnSync(process.execPath, [script, command, "--data-dir", dataDirectory], {
    stdio: "inherit",
  });
  if (result.error) throw new Error("Could not start the installed plugin command.");
  process.exitCode = result.status ?? 1;
}
