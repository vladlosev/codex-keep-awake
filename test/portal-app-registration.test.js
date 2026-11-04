import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensurePortalDesktopEntry,
  getPortalAppId,
  PORTAL_APP_ID,
} from "../src/portal-app-registration.js";

const generatedMarker = "X-Codex-Keep-Awake-Generated=true";

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "keep-awake-registration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("portal app identity detects exact MATE and Cinnamon desktop identifiers", () => {
  for (const environment of [
    { XDG_CURRENT_DESKTOP: "MATE" },
    { XDG_SESSION_DESKTOP: "mate" },
    { XDG_SESSION_DESKTOP: "ubuntu-mate" },
    { XDG_CURRENT_DESKTOP: "X-Cinnamon:GNOME" },
    { XDG_CURRENT_DESKTOP: " GNOME : CInNaMoN ", XDG_SESSION_DESKTOP: "GNOME" },
    { XDG_SESSION_DESKTOP: "cinnamon" },
  ]) {
    assert.equal(getPortalAppId({ platform: "linux", environment }), PORTAL_APP_ID);
  }
});

test("portal app identity excludes unrelated desktops and non-Linux platforms", () => {
  for (const environment of [
    { XDG_CURRENT_DESKTOP: "GNOME" },
    { XDG_CURRENT_DESKTOP: "KDE" },
    { XDG_SESSION_DESKTOP: "xfce" },
    {},
  ]) {
    assert.equal(getPortalAppId({ platform: "linux", environment }), null);
  }
  assert.equal(getPortalAppId({ platform: "win32", environment: { XDG_CURRENT_DESKTOP: "MATE" } }), null);
});

test("desktop entry is user-scoped, hidden, and has escaped absolute Exec arguments", (t) => {
  const directory = temporaryDirectory(t);
  const dataHome = path.join(directory, "xdg data");
  const nodePath = path.join(directory, "node bin", "node$debug");
  const scriptPath = path.join(directory, "package files", "cli`%.js");
  const { desktopFilePath } = ensurePortalDesktopEntry({
    appId: PORTAL_APP_ID,
    environment: { XDG_DATA_HOME: dataHome, HOME: directory },
    execPath: nodePath,
    packageScriptPath: scriptPath,
  });

  assert.equal(desktopFilePath, path.join(dataHome, "applications", `${PORTAL_APP_ID}.desktop`));
  const content = readFileSync(desktopFilePath, "utf8");
  assert.match(content, /^\[Desktop Entry\]$/m);
  assert.match(content, /^Type=Application$/m);
  assert.match(content, /^Name=Codex Keep Awake Extension$/m);
  assert.match(content, /^Exec=".*" ".*" status$/m);
  assert.ok(content.includes(`Exec="${nodePath.replaceAll("$", "\\$")}" "${scriptPath.replaceAll("`", "\\`").replaceAll("%", "%%")}" status`));
  assert.match(content, /^Terminal=true$/m);
  assert.match(content, /^NoDisplay=true$/m);
  assert.match(content, new RegExp(`^${generatedMarker}$`, "m"));
  assert.equal(statSync(desktopFilePath).mode & 0o600, 0o600);
});

test("desktop entry defaults to HOME and identity detection does not write files", (t) => {
  const directory = temporaryDirectory(t);
  const environment = { HOME: directory, XDG_CURRENT_DESKTOP: "MATE" };
  assert.equal(getPortalAppId({ platform: "linux", environment }), PORTAL_APP_ID);
  assert.deepEqual(awaitlessReadDir(path.join(directory, ".local", "share")), []);

  const { desktopFilePath } = ensurePortalDesktopEntry({
    appId: PORTAL_APP_ID,
    environment,
    execPath: "/usr/bin/node",
    packageScriptPath: "/opt/codex-keep-awake/scripts/codex-keep-awake.js",
  });
  assert.equal(
    desktopFilePath,
    path.join(directory, ".local", "share", "applications", `${PORTAL_APP_ID}.desktop`),
  );
});

test("identical generated desktop entries are left untouched and old generated entries update", (t) => {
  const directory = temporaryDirectory(t);
  const options = {
    appId: PORTAL_APP_ID,
    environment: { XDG_DATA_HOME: directory, HOME: directory },
    execPath: "/usr/bin/node",
    packageScriptPath: "/opt/codex-keep-awake/scripts/codex-keep-awake.js",
  };
  const { desktopFilePath } = ensurePortalDesktopEntry(options);
  const originalContent = readFileSync(desktopFilePath, "utf8");
  const originalInode = statSync(desktopFilePath).ino;

  ensurePortalDesktopEntry(options);
  assert.equal(readFileSync(desktopFilePath, "utf8"), originalContent);
  assert.equal(statSync(desktopFilePath).ino, originalInode);

  writeFileSync(desktopFilePath, `[Desktop Entry]\nName=Old generated entry\n${generatedMarker}\n`);
  const previousInode = statSync(desktopFilePath).ino;
  ensurePortalDesktopEntry(options);
  assert.match(readFileSync(desktopFilePath, "utf8"), /^Name=Codex Keep Awake Extension$/m);
  assert.notEqual(statSync(desktopFilePath).ino, previousInode);
});

test("an unmarked desktop entry is preserved and reports a sanitized conflict", (t) => {
  const directory = temporaryDirectory(t);
  const applications = path.join(directory, "applications");
  mkdirSync(applications);
  const desktopFilePath = path.join(applications, `${PORTAL_APP_ID}.desktop`);
  const originalContent = "[Desktop Entry]\nName=User application\n";
  writeFileSync(desktopFilePath, originalContent);

  assert.throws(() => ensurePortalDesktopEntry({
    appId: PORTAL_APP_ID,
    environment: { XDG_DATA_HOME: directory, HOME: directory },
    execPath: "/usr/bin/node",
    packageScriptPath: "/opt/codex-keep-awake/scripts/codex-keep-awake.js",
  }), {
    code: "PORTAL_DESKTOP_ENTRY_FAILED",
    message: "The Codex Keep Awake desktop identity entry could not be prepared",
  });
  assert.equal(readFileSync(desktopFilePath, "utf8"), originalContent);
});

function awaitlessReadDir(directory) {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
