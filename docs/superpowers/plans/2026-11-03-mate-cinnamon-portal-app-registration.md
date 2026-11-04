# MATE and Cinnamon Portal App Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Work inline unless the user asks for delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Codex Keep Awake's portal D-Bus connection under an extension-specific app ID on MATE and Cinnamon, backed by a per-user hidden desktop entry.

**Architecture:** Detect MATE or Cinnamon from the session's XDG desktop identifiers. When Registry is available on either desktop, create or refresh a marked desktop entry under the user's XDG applications directory, then call `org.freedesktop.host.portal.Registry.Register` on the same session-bus connection before `Inhibit`. Other desktops, and portals without Registry support, retain the existing inhibition flow without registration or desktop-file creation.

**Tech Stack:** Node.js `^24.17.0`, bundled `dbus-native@0.16.2`, XDG Desktop Portal Registry and Inhibit D-Bus APIs, Desktop Entry Specification, Node.js built-in test runner.

**Spec:** The current user request, made concrete in the design and acceptance contract below; the existing portal lease behavior in `src/portal-inhibitor.js` remains the runtime contract.

## Global Constraints

- Register only when `XDG_CURRENT_DESKTOP` or `XDG_SESSION_DESKTOP` identifies MATE or Cinnamon; do not infer either from a generic GNOME identifier.
- Use the extension-specific ID `io.github.vladlosev.CodexKeepAwake`, separate from Codex's own identity.
- Create `io.github.vladlosev.CodexKeepAwake.desktop` in `$XDG_DATA_HOME/applications/`, defaulting to `~/.local/share/applications/`.
- The entry must use `Terminal=true` and `NoDisplay=true`. Desktop Entry booleans use lowercase `true`/`false`, so write `NoDisplay=true` as the specification-compliant form of the requested `True`.
- Register on the same D-Bus connection used for `Inhibit`, before the first portal method call on that connection. Register at most once per connection.
- Preserve suspend-only flag `4`, response correlation, request cleanup, retries, lease lifecycle, and existing non-Linux behavior.
- Add no runtime npm dependency, install lifecycle script, or generated build step. The package already includes `src/` and `scripts/`.
- Inject an empty or temporary environment into fake-D-Bus tests so no test writes to the real user's XDG applications directory.
- Preserve unrelated files and Jujutsu state. Do not commit, push, or publish as part of implementation.

---

## Design and Acceptance Contract

### Desktop manager detection

Create one pure detector that reads `XDG_CURRENT_DESKTOP` as colon-separated identifiers and `XDG_SESSION_DESKTOP` as a single identifier, trims and case-folds tokens, then matches exact aliases:

- MATE: `mate`, `ubuntu-mate`
- Cinnamon: `cinnamon`, `x-cinnamon`

Return `null` for GNOME-only, KDE, Xfce, empty, and unknown identifiers. If one variable names a supported manager and the other contains a generic value such as `GNOME`, the supported exact token is sufficient. On non-Linux platforms, return `null` without reading or writing desktop files.

### Desktop entry

Use the extension-specific ID and file name:

```text
ID:   io.github.vladlosev.CodexKeepAwake
File: io.github.vladlosev.CodexKeepAwake.desktop
```

Write a valid `[Desktop Entry]` into `$XDG_DATA_HOME/applications/`, using `$HOME/.local/share` when `XDG_DATA_HOME` is unset or empty. Generate `Exec` from the running Node executable and the packaged `scripts/codex-keep-awake.js` path, followed by the `status` argument. Quote/escape each argument according to the Desktop Entry `Exec` grammar, not shell quoting. Use these fields:

```ini
[Desktop Entry]
Type=Application
Name=Codex Keep Awake Extension
Exec="<absolute-node-path>" "<absolute-package-script-path>" status
Terminal=true
NoDisplay=true
X-Codex-Keep-Awake-Generated=true
```

The application ID is determined by the desktop file ID, not its `Name`. The `X-Codex-Keep-Awake-Generated=true` marker distinguishes this generated entry from a user-created file. Create the applications directory if needed. If the destination already contains identical content, leave it untouched. If it contains this marker with older generated content, replace it atomically. If an unmarked file already occupies the ID, preserve it and fail registration with a sanitized, actionable error instead of overwriting it. Keep the entry after an individual plugin lease ends because Codex and OpenCode may use the same per-user identity concurrently. Document how to remove the marked entry after uninstalling the extension.

The current upstream portal resolves the registered ID through `<app_id>.desktop`, so the file must be visible in an XDG applications directory before `Register` is called. The Desktop Entry Specification requires `Type` and `Name`; `Exec` is required for a non-D-Bus-activatable entry and remains included here. See the [Registry API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html), [Desktop Entry Specification](https://specifications.freedesktop.org/desktop-entry/latest-single/), and [boolean value rules](https://specifications.freedesktop.org/desktop-entry/latest/value-types.html).

### D-Bus registration sequence

For a supported desktop, detect the app ID without writing files. On the newly opened dedicated session-bus connection:

1. Complete the existing `Hello`, signal-match, and portal-owner setup.
2. Query `org.freedesktop.host.portal.Registry`'s `version` property. If Registry is unavailable or reports version `0`, continue through the existing `Inhibit` path without calling `Register` or creating a desktop entry.
3. If the version is at least `1`, create or refresh the user entry, then call `Register` with signature `sa{sv}`, body `["io.github.vladlosev.CodexKeepAwake", {}]`.
4. Only after successful registration, call the existing `Inhibit` method on that same connection.

If writing the entry fails, return code `PORTAL_DESKTOP_ENTRY_FAILED` with message `The Codex Keep Awake desktop identity entry could not be prepared`. If a supported Registry rejects `Register`, return code `PORTAL_APP_REGISTRATION_FAILED` with message `The XDG Desktop Portal rejected the Codex Keep Awake app identity`, close the bus, and let the existing retry policy try again. Preserve these fixed sanitized errors through `sanitizeAcquisitionError`; do not expose raw filesystem or D-Bus exception text. Do not call `Inhibit` on that connection with an unregistered identity after an explicit registration failure. Each new acquisition owns a new D-Bus connection, so each such connection performs its own one-time registration. Non-MATE/Cinnamon sessions skip both desktop-file creation and the Registry calls.

### Acceptance criteria

1. MATE and Cinnamon identifiers produce the extension ID and a valid user-scoped `.desktop` entry with `Terminal=true` and `NoDisplay=true`.
2. The D-Bus trace on a supported desktop shows `Registry.Register` before `Inhibit`, on the same connection, with the extension ID and an empty options dictionary.
3. An unsupported Registry interface preserves the current portal inhibition attempt without registration.
4. GNOME, KDE, Xfce, other desktops, Windows, and macOS do not create the entry or call Registry.
5. A pre-existing unmarked entry is never overwritten; a marked generated entry updates atomically and idempotently.
6. Existing active-work, permission-wait, question-wait, idle, cancellation, retry, portal-owner-change, and release behavior remains unchanged.
7. The packed package works without lifecycle scripts or new dependencies.
8. Live MATE and Cinnamon runs show the native session inhibitor during active work and release it on the existing idle/wait transitions. Portal `Response=0` or `systemd-inhibit --list` alone is not the native-inhibition acceptance check for these XApp-backed sessions.

## File Structure

- Create `src/portal-app-registration.js` for exact desktop-manager detection, the extension app ID constant, XDG path resolution, desktop-entry rendering/escaping, and safe idempotent installation.
- Modify `src/portal-inhibitor.js` to prepare the optional registration and send `Registry.Register` before `Inhibit` on the existing connection.
- Modify `src/backend.js` to pass injected platform/environment values into acquisition for deterministic manager-gating tests.
- Create `test/portal-app-registration.test.js` for detection, generated-entry contents, path selection, quoting, idempotence, and conflict protection.
- Modify `test/portal-inhibit.test.js` and its fake D-Bus setup to verify Registry call order, exact signature/body, same-connection behavior, unsupported-Registry fallback, and failure cleanup.
- Modify `test/helpers/fake-portal-dbus.cjs`, `test/helpers/fake-portal-service.cjs`, and `test/portal-package.test.js` to exercise the behavior from the packed package on a private D-Bus daemon.
- Update `README.md` and `docs/opencode.md` with the MATE/Cinnamon entry creation and removal behavior; update `AGENTS.md` with the manager gate and test coverage.

## Implementation Tasks

### Task 1: Build the MATE/Cinnamon identity and desktop-entry helper

**Files:** Create `src/portal-app-registration.js` and `test/portal-app-registration.test.js`.

**Interfaces:** Produce `getPortalAppId({ platform, environment })`, returning `null` off Linux or outside MATE/Cinnamon, or `"io.github.vladlosev.CodexKeepAwake"`. Produce `ensurePortalDesktopEntry({ appId, environment, execPath, packageScriptPath })`, returning `{ desktopFilePath }` after writing the entry. Throw code `PORTAL_DESKTOP_ENTRY_FAILED` with fixed message `The Codex Keep Awake desktop identity entry could not be prepared` on unsafe conflicts or write failures.

- [ ] **Step 1: Add failing manager-detection tests.** Test positive identifiers `XDG_CURRENT_DESKTOP=MATE`, `XDG_SESSION_DESKTOP=mate`, `XDG_SESSION_DESKTOP=ubuntu-mate`, `XDG_CURRENT_DESKTOP=X-Cinnamon:GNOME`, and `XDG_SESSION_DESKTOP=cinnamon`. Test that GNOME-only, KDE, Xfce, unset variables, and `platform="win32"` return `null`.
- [ ] **Step 2: Run the focused test to verify it fails.** Run `node --test test/portal-app-registration.test.js`; expect import/function failures before implementation.
- [ ] **Step 3: Add failing desktop-entry tests.** Under a temporary XDG data home, assert the returned path; exact `Type`, `Name`, `Terminal=true`, `NoDisplay=true`, ownership marker, and absolute `Exec` arguments; ensure paths containing spaces are encoded per the Desktop Entry `Exec` rules. Assert the file is under `<temp>/applications/` and mode is owner-writable/readable. A manager detector call alone must not create files.
- [ ] **Step 4: Add idempotence and conflict tests.** Repeating preparation with identical inputs must preserve file contents. A marked older entry may be replaced atomically. An unmarked entry at the same filename must remain byte-for-byte unchanged and return the conflict error.
- [ ] **Step 5: Implement the helper.** Export `PORTAL_APP_ID = "io.github.vladlosev.CodexKeepAwake"`, `getPortalAppId({ platform = process.platform, environment = process.env })`, and `ensurePortalDesktopEntry({ appId, environment = process.env, execPath = process.execPath, packageScriptPath })`. Use exact XDG identifier tokens, compute `$XDG_DATA_HOME` with the `$HOME/.local/share` fallback, render the entry above, and update only entries bearing the generated marker. Return fixed error code/message pairs on write failures without retaining raw exception text.
- [ ] **Step 6: Run the focused test to verify it passes.** Run `node --test test/portal-app-registration.test.js`; expect all identity, contents, escaping, idempotence, and conflict checks to pass.

### Task 2: Register before `Inhibit` on the same D-Bus connection

**Files:** Modify `src/portal-inhibitor.js`, `src/backend.js`, `test/portal-inhibit.test.js`, and the fake D-Bus setup used by that test.

**Interfaces:** `PortalInhibitorBackend` accepts an injected `environment` defaulting to `process.env`, and forwards it with `platform` to `acquirePortalInhibitor`. `acquirePortalInhibitor` detects the optional ID, negotiates Registry support, ensures the desktop entry only when Registry version is at least `1`, then sends `Register` before `Inhibit`.

- [ ] **Step 1: Add a failing portal protocol test for MATE.** Inject a temporary XDG data home and `XDG_CURRENT_DESKTOP="MATE"`. Record all calls and assert `Registry.Register` has signature `sa{sv}`, body `[PORTAL_APP_ID, {}]`, and precedes `Inhibit` on the same fake bus object.
- [ ] **Step 2: Add failing gate and compatibility tests.** For `XDG_CURRENT_DESKTOP="GNOME"`, assert no Registry call and no desktop file. For a supported desktop with Registry version `0` or `UnknownInterface`, assert no Register call, no desktop file, and that the existing `Inhibit` request still runs. For a Registry `Register` rejection, assert code `PORTAL_APP_REGISTRATION_FAILED`, its fixed sanitized message, no `Inhibit` call, and a closed bus.
- [ ] **Step 3: Run the focused portal test to verify failures.** Run `node --test test/portal-inhibit.test.js`; expect the new registration assertions to fail before implementation.
- [ ] **Step 4: Add deterministic dependency forwarding.** Store `environment = process.env` in `PortalInhibitorBackend` and pass `platform` plus `environment` into `acquirePortalInhibitor`. Update existing fake-D-Bus tests to inject `{}` or a temporary XDG environment so they cannot write to the real user's home.
- [ ] **Step 5: Add the registration call.** Detect the optional ID before connecting without writing a file. After owner discovery and before `Inhibit`, query Registry `version`; if `>= 1`, ensure the desktop entry and call `Register`. Treat absence/unsupported interface as the existing non-registration path. Preserve the fixed sanitized `PORTAL_DESKTOP_ENTRY_FAILED` and `PORTAL_APP_REGISTRATION_FAILED` errors through `sanitizeAcquisitionError`; on either error, run existing bus/request cleanup.
- [ ] **Step 6: Run focused regression tests.** Run `node --test test/portal-inhibit.test.js test/backend.test.js`; expect the new sequence/gating tests and existing acquisition, cancellation, owner-change, retry, and close tests to pass.

### Task 3: Verify the packaged behavior and document user-visible file handling

**Files:** Modify `test/helpers/fake-portal-dbus.cjs`, `test/helpers/fake-portal-service.cjs`, `test/portal-package.test.js`, `README.md`, `docs/opencode.md`, and `AGENTS.md`.

**Interfaces:** The npm archive contains the helper via its existing `src/` inclusion. The private portal fixture accepts Registry `version` and `Register`, records the supplied app ID/order, and accepts the subsequent suspend-only `Inhibit` call.

- [ ] **Step 1: Extend the private D-Bus fixture.** Add Registry introspection/version support and a `Register(sa{sv})` method that records app ID and event order. Keep all behavior on the private daemon; do not connect package validation to the user's session bus.
- [ ] **Step 2: Add a packed-consumer MATE scenario.** In `test/portal-package.test.js`, set `XDG_CURRENT_DESKTOP=MATE` and a temporary `XDG_DATA_HOME` for the installed package subprocess. Assert the archive-created desktop entry has the required flags, the Registry event uses `io.github.vladlosev.CodexKeepAwake`, and Registry precedes Inhibit.
- [ ] **Step 3: Add packed-consumer fallback scenarios.** Run the same installed backend with `XDG_CURRENT_DESKTOP=GNOME` and with `XDG_CURRENT_DESKTOP=MATE` against a fake portal that has no Registry interface, each with a separate temporary data home. Assert both make the existing Inhibit call without Register and neither creates the applications directory.
- [ ] **Step 4: Run package tests.** Run `node --test test/portal-package.test.js`; expect both isolated desktop scenarios to pass against the packed artifact without optional/dev packages or lifecycle scripts.
- [ ] **Step 5: Document installation side effect and cleanup.** In README and `docs/opencode.md`, say MATE/Cinnamon sessions create the hidden extension-owned entry under `${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.vladlosev.CodexKeepAwake.desktop`; explain that Codex's own ID remains independent and give the removal command guarded by checking the `X-Codex-Keep-Awake-Generated=true` marker first.
- [ ] **Step 6: Update development guidance.** In `AGENTS.md`, record the exact manager gate, ID, same-connection ordering, Registry-unavailable behavior, unit/package test commands, and that actual XApp inhibition must be verified from the session manager.
- [ ] **Step 7: Run repository checks.** Run `npm test`, `npm run validate:package`, `npm run test:gnome`, and `npm run test:opencode-gnome`. Expect existing GNOME behavior and both OpenCode adapters to remain unchanged because GNOME is outside the registration gate.
- [ ] **Step 8: Verify live MATE and Cinnamon behavior.** On each desktop, start active Codex work and an OpenCode model session separately; confirm the generated entry and Registry call, then confirm the native XApp/session-manager inhibitor appears while active and disappears for permission/question waits and idle. Inspect the D-Bus request sequence or portal logs to confirm the extension ID reached XApp.
- [ ] **Step 9: Review only the intended diff.** Run `jj status` and `jj diff --stat`, then inspect the new module, `.desktop` output assertions, D-Bus ordering, docs, and tests. Confirm no package dependency, lifecycle script, unrelated file, commit, or remote reference changed.

## Self-Review

- Manager gating is tested for MATE, Cinnamon, GNOME, KDE, Xfce, unknown, and non-Linux cases.
- The extension-specific app ID and generated file are specified exactly; the desktop file is installed where the portal resolves desktop IDs.
- `Terminal=true` and spec-valid lowercase `NoDisplay=true` are present and tested.
- Registry version negotiation, same-connection ordering, absence fallback, fixed sanitized error reporting, failure cleanup, package archive inclusion, and desktop-manager lifecycle validation each have a named task.
- User-local file persistence and removal are documented; individual lease shutdown does not delete a file shared by concurrent hosts.
