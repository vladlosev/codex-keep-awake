import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PORTAL_APP_ID = "io.github.vladlosev.CodexKeepAwake";

const DESKTOP_FILE_NAME = `${PORTAL_APP_ID}.desktop`;
const GENERATED_MARKER = "X-Codex-Keep-Awake-Generated=true";
const DESKTOP_ENTRY_FAILED = "The Codex Keep Awake desktop identity entry could not be prepared";
const DEFAULT_PACKAGE_SCRIPT_PATH = fileURLToPath(new URL("../scripts/codex-keep-awake.js", import.meta.url));

function failure() {
  return Object.assign(new Error(DESKTOP_ENTRY_FAILED), { code: "PORTAL_DESKTOP_ENTRY_FAILED" });
}

function desktopIdentifiers(environment) {
  const current = typeof environment?.XDG_CURRENT_DESKTOP === "string"
    ? environment.XDG_CURRENT_DESKTOP.split(":")
    : [];
  const session = typeof environment?.XDG_SESSION_DESKTOP === "string"
    ? [environment.XDG_SESSION_DESKTOP]
    : [];
  return [...current, ...session]
    .map((identifier) => identifier.trim().toLowerCase())
    .filter(Boolean);
}

export function getPortalAppId({ platform = process.platform, environment = process.env } = {}) {
  if (platform !== "linux") return null;
  const identifiers = desktopIdentifiers(environment);
  return identifiers.some((identifier) => ["mate", "ubuntu-mate", "cinnamon", "x-cinnamon"].includes(identifier))
    ? PORTAL_APP_ID
    : null;
}

function applicationsDirectory(environment) {
  const xdgDataHome = environment?.XDG_DATA_HOME;
  if (typeof xdgDataHome === "string" && xdgDataHome.length > 0 && path.isAbsolute(xdgDataHome)) {
    return path.join(xdgDataHome, "applications");
  }
  const home = environment?.HOME;
  if (typeof home !== "string" || !path.isAbsolute(home)) throw failure();
  return path.join(home, ".local", "share", "applications");
}

function quoteExecArgument(argument) {
  const escaped = String(argument)
    .replaceAll("%", "%%")
    .replace(/[\\"`$]/g, "\\$&");
  return `"${escaped}"`;
}

function renderDesktopEntry({ execPath, packageScriptPath }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Codex Keep Awake Extension",
    `Exec=${quoteExecArgument(path.resolve(execPath))} ${quoteExecArgument(path.resolve(packageScriptPath))} status`,
    "Terminal=true",
    "NoDisplay=true",
    GENERATED_MARKER,
    "",
  ].join("\n");
}

function hasGeneratedMarker(content) {
  let inDesktopEntry = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
    } else if (inDesktopEntry && line === GENERATED_MARKER) {
      return true;
    }
  }
  return false;
}

function readCurrentFile(filePath) {
  try {
    if (!lstatSync(filePath).isFile()) throw failure();
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeTemporaryFile(directory, fileName, content) {
  const temporaryPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  let open = true;
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    open = false;
  } catch (error) {
    if (open) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
  return temporaryPath;
}

function installAtomically(directory, destination, content) {
  const fileName = path.basename(destination);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = readCurrentFile(destination);
    if (existing === content) return;
    if (existing !== null && !hasGeneratedMarker(existing)) throw failure();

    const temporaryPath = writeTemporaryFile(directory, fileName, content);
    try {
      if (existing === null) {
        try {
          // A hard link publishes the fully-written file without replacing an
          // entry created by another plugin process or by the user.
          linkSync(temporaryPath, destination);
        } catch (error) {
          if (error?.code === "EEXIST") continue;
          throw error;
        }
        return;
      }

      const current = readCurrentFile(destination);
      if (current !== existing) continue;
      if (!hasGeneratedMarker(current)) throw failure();
      renameSync(temporaryPath, destination);
      return;
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {}
    }
  }
  throw failure();
}

export function ensurePortalDesktopEntry({
  appId,
  environment = process.env,
  execPath = process.execPath,
  packageScriptPath = DEFAULT_PACKAGE_SCRIPT_PATH,
} = {}) {
  try {
    if (appId !== PORTAL_APP_ID || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(appId)) throw failure();
    const directory = applicationsDirectory(environment);
    const destination = path.join(directory, DESKTOP_FILE_NAME);
    const content = renderDesktopEntry({ execPath, packageScriptPath });
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    // Reject symlinks and special files instead of following or replacing them.
    installAtomically(directory, destination, content);
    return { desktopFilePath: destination };
  } catch {
    throw failure();
  }
}
