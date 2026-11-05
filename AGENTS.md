# Development guidance

Keep README.md focused on user guidance for Codex CLI and OpenCode, including
requirements, protection behavior, and each host's installation and removal
steps. Keep OpenCode version-specific configuration and activity expectations
alongside its installation instructions. Put desktop-specific system setup,
cleanup, inhibition verification, and troubleshooting in
[docs/desktop-setup.md](docs/desktop-setup.md), linked from README.md. Put
development guidance, local-checkout workflows, and runtime implementation
details in this file.

Documents under `docs/superpowers/plans/` are historical implementation plans
and validation records. They may contain outdated instructions, paths,
dependencies, and unfinished checklists for work that has since been completed.
Use them as background; verify their applicability against the current code
and documentation. Their old constraints and checklists do not override current
guidance or create new implementation tasks.

## Development setup and checks

Use Node.js 24.17.0 or newer within the Node 24 series (`^24.17.0`). From the
repository root, install development dependencies and run the checks:

```sh
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run validate:package
```

The pinned `ws@8.22.0` package is a development dependency used only by test
servers. `dbus-native@0.16.2` is the Linux portal client's runtime dependency.
Its original package and the `xml2js`, `sax`, and `xmlbuilder` packages it uses
are vendored under `node_modules/` and included in the npm archive through
`bundleDependencies`. Keep those package sources and license notices intact.
Runtime users install no separate npm dependencies. CI tests the minimum Node
version and the latest Node 24 release.

The regular test suite uses controlled app-server and inhibitor processes,
including native WebSocket handshake, message, timeout, retry, and cleanup
checks. Portal protocol tests use a fake D-Bus client and never connect to the
desktop session bus. They cover MATE/Cinnamon Registry negotiation and desktop
entry ownership. Package validation packs the real archive, installs it
offline in a temporary consumer without development dependencies or lifecycle
scripts, checks the OpenCode entrypoint and idle lifecycles, then uses a private
D-Bus daemon and fake portal to exercise the installed backend in its host
process. The vendored packages have no build or generated-bundle step.

Use this guide to choose checks and interpret their results:

| Check | When to run it | Prerequisites and coverage |
| --- | --- | --- |
| `npm test` | After runtime or test changes; before handing off a change | Supported Node and root development dependencies. Controlled processes and fake portal clients verify activity, transport, state, and cleanup without the desktop bus. The PowerShell parser check runs only on Windows. |
| `npm run validate:package` | After packaging, runtime, or distributed-documentation changes | Root dependencies and npm. Packs and installs the archive offline, then checks installed entrypoints and lifecycles. The private portal test requires Linux and `dbus-daemon`; it is skipped otherwise. A passing command with that skip does not verify the packed portal backend. |
| `node --test test/portal-app-registration.test.js test/portal-inhibit.test.js` | While changing portal registration or protocol handling | Supported Node and root dependencies. Fake D-Bus checks verify registration, ownership, request ordering, failure handling, and cleanup without the desktop bus. |
| `npm run test:gnome` | After Codex activity or Linux inhibition changes, on GNOME | A logged-in GNOME session, working portal, and `gnome-session-inhibit`. Requires no pre-existing inhibitor with the test's `Codex portal integration probe` reason. Exercises the real native inhibitor through a controlled app-server. See [Codex Linux portal integration checks](#codex-linux-portal-integration-checks) for the optional timed hold. |
| `npm run test:opencode-gnome` | After OpenCode activity or Linux inhibition changes, on GNOME | The same desktop prerequisites and no pre-existing OpenCode Keep Awake inhibitor. Injects events through both adapters and checks native acquisition and release; preserves Codex inhibitors. |
| Actual OpenCode host checks | After changing host compatibility, package loading, or installation instructions | The pinned hosts, disposable configuration, and a synthetic provider described [below](#opencode-development-and-compatibility). These verify real host loading and behavior, separately from injected-event desktop tests. |

Report skipped or unavailable checks explicitly. A protocol test, packed import,
or portal acceptance is not evidence that a desktop applied a native inhibitor.

## Source map

| Area | Files to inspect |
| --- | --- |
| Codex hooks, state, and process ownership | [hooks/hooks.json](hooks/hooks.json), [src/hook-runtime.js](src/hook-runtime.js), [src/state.js](src/state.js) |
| Codex observation and protection lifecycle | [src/app-server-observer.js](src/app-server-observer.js), [src/unix-websocket.js](src/unix-websocket.js), [src/supervisor.js](src/supervisor.js) |
| Runtime commands and installed-plugin discovery | [scripts/codex-keep-awake.js](scripts/codex-keep-awake.js), [src/cli.js](src/cli.js), [src/installed-plugin.js](src/installed-plugin.js) |
| OpenCode entrypoint, shared activity, and backend selection | [src/opencode-entry.js](src/opencode-entry.js), [src/opencode-plugin.js](src/opencode-plugin.js), [src/opencode-activity.js](src/opencode-activity.js), [src/opencode-backend.js](src/opencode-backend.js) |
| OpenCode V2 event translation and observation | [src/opencode-v2-events.js](src/opencode-v2-events.js), [src/opencode-v2-plugin.js](src/opencode-v2-plugin.js) |
| Linux portal acquisition and app registration | [src/backend.js](src/backend.js), [src/portal-inhibitor.js](src/portal-inhibitor.js), [src/portal-app-registration.js](src/portal-app-registration.js) |
| Windows and retained macOS helpers | [src/windows-backend.js](src/windows-backend.js), [src/lease-backend.js](src/lease-backend.js), [src/windows-keep-awake.ps1](src/windows-keep-awake.ps1), [src/macos-keep-awake.swift](src/macos-keep-awake.swift) |
| Distribution and archive validation | [package.json](package.json), [.codex-plugin/plugin.json](.codex-plugin/plugin.json), [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), [test/package.test.js](test/package.test.js), [test/opencode-package.test.js](test/opencode-package.test.js), [test/portal-package.test.js](test/portal-package.test.js) |

## Runtime change rules

- Keep Codex hooks advisory and within their three-second timeout. Return `{}`
  or an informational `systemMessage`; do not change approval decisions.
- Keep state private. Use the existing exclusive locks and atomic writes for
  updates so concurrent hooks cannot lose registrations or start duplicate
  supervisors. Preserve checks that prevent stale events clearing newer work.
- Verify process identity, including its start token, before signaling a
  supervisor. A PID alone does not establish ownership because it can be reused.
- Reduce events to the identifiers and activity state the tracker needs. Do not
  retain prompts, commands, transcripts, answers, credentials, or raw events in
  state or logs. Keep failure messages sanitized.

## Install this checkout in Codex CLI

This repository includes a local marketplace in
`.agents/plugins/marketplace.json`. In a terminal, add this checkout as a
marketplace and install the plugin:

```sh
cd "/absolute/path/to/codex-keep-awake"
codex plugin marketplace add "$PWD"
codex plugin add codex-keep-awake@codex-keep-awake
```

Start a new Codex CLI session, enter `/hooks`, then review and trust the
plugin's hook commands. Codex skips untrusted hooks. See [README.md](README.md)
for normal operation and removal.

GitHub marketplace installation includes the runtime directly and does not
require publishing to npm.

## Codex runtime diagnostics and recovery

Normal installation and removal use Codex's plugin commands and require no
global npm CLI. For development diagnostics or recovery, invoke the existing
runtime script directly from this checkout:

```sh
node scripts/codex-keep-awake.js status
node scripts/codex-keep-awake.js cleanup
```

Without an explicit data directory, these commands query
`codex plugin list --marketplace codex-keep-awake --json` and invoke the active
cached plugin version with its private data directory. The plugin must still
be installed and Codex must be on `PATH` for discovery to work.

An explicit `--data-dir` argument or `PLUGIN_DATA` environment variable bypasses
discovery and operates directly on that directory. The normal installed path
is `${CODEX_HOME:-$HOME/.codex}/plugins/data/codex-keep-awake-codex-keep-awake`.
Use the same directory as the affected hooks; cleanup of another directory
does not stop their supervisor. Tests must isolate both
`CODEX_HOME` and the default home-directory fallback when testing discovery.

On normal Codex exit, the `SessionEnd` hook removes its thread registration.
When no registered threads remain, the hook signals the shared supervisor to
exit and release protection. The supervisor is detached; a crash, forced exit,
or failed end hook can leave it running. Use the recovery command before
removing the plugin in that case. It clears bookkeeping and signals shutdown,
but leaves the data directory in place; wait for the supervisor to exit before
deleting that directory. The diagnostic commands remain available in the
runtime for tests and recovery, rather than as required user management steps.

## OpenCode development and compatibility

For user-facing setup and shared requirements, see [README.md](README.md#opencode).
Desktop support, MATE setup, native inhibitor checks, and desktop cleanup are
in [docs/desktop-setup.md](docs/desktop-setup.md).
This checkout does not automatically register the plugin in OpenCode. Tests
import the package's canonical entrypoint directly.

Use the V1 and V2 compatibility baselines listed in
[README.md](README.md#opencode) for host checks. The same default export
provides V1 `server()` hooks and V2 `setup(ctx)` with an event subscription and
cleanup function. The entrypoint imports no OpenCode API package; both versions
share the activity tracker and native backends. Root `npm ci` is enough for the
regular tests; installing dependencies inside `.opencode/` is not a test
prerequisite. Earlier V1 object entrypoints exist from `1.18.29`, but earlier
releases below the documented baseline have not been validated here.

The canonical definition lives in `src/opencode-entry.js`. The root package
exposes it as `codex-keep-awake/server` through `exports["./server"]`. The
existing `src/` package contents include its runtime imports and native helpers;
`.opencode/` stays outside the archive. No build or prepare script is needed.

OpenCode V1 also discovers `setup()` through its internal V2 command/catalog
host, whose context lacks the V2 activity-event API. The entrypoint skips
observation when `ctx.event.subscribe` is unavailable; V1 activity protection
continues through `server()`. Exercise V1's `/api/command` and `/api/reference`
routes as well as a model session during actual-host checks. Session-only
checks do not cover this TUI initialization path. The catalog context and
absence of a failure advisory are covered by the loader regression test.

Use one installation route per project. Test package installation in a
disposable project with isolated configuration so an existing installation
cannot hide a missing package entrypoint or start another plugin instance.

For actual package-host checks, use the pinned binaries by absolute path with
separate temporary HOME, XDG config/data/state/cache, and npm/Git configuration.
Install a full revision of a disposable Git repository containing the packed
artifact, then run each host's private loopback server with a local synthetic
provider. Confirm the loaded module path belongs to that host's private package
cache. On Linux, the OpenCode host owns the portal connection directly; there
is no separate Linux inhibitor helper to identify. Check that host's native
inhibitor during work, waits, resumption, completion, and host shutdown. On
Windows, identify the package-owned PowerShell helper and check its system
power request through the same transitions. Preserve pre-existing inhibitors
and stop and await all probe-owned hosts, providers, and Windows helpers before
removing fixtures. The
[GitHub installation plan](docs/superpowers/plans/2026-10-15-opencode-github-installation.md)
records historical procedures and results; adapt its old helper-based checks
to the current ownership described here. Local archive/Git validation is separate
from installation of an updated remote GitHub revision, which requires that
revision to be available remotely.

The shared tracker requests suspend inhibition through the XDG Desktop Portal
for busy and retrying sessions. Permission and answer waits release protection
for that session and its busy parents; another active session keeps the shared
lease. Idle, failed, or deleted sessions release their protection. The display
may still blank and lock normally. User-facing requirements are in
[README.md](README.md#requirements); desktop support and live verification
status are in [docs/desktop-setup.md](docs/desktop-setup.md#desktop-support).

The portal selects the configured desktop backend. A portal `Response=0` means
the portal accepted the request; it does not verify that the desktop power
manager applied a native inhibitor. The backend reports active only after that
response, retries unavailable requests every five seconds while work remains
active, and releases on idle, host shutdown, or session-bus loss.

Run `npm test` for event and lifecycle checks. On GNOME,
`npm run test:opencode-gnome` checks that real native inhibition follows busy,
permission-wait, resumed, question-wait, idle, and cleanup events through both
adapters. These desktop checks inject controlled events; actual-host checks
separately use the pinned OpenCode binaries in disposable projects with an
isolated configuration and a local synthetic model provider. The test uses a
distinct OpenCode inhibitor reason and leaves any Codex inhibitor alone.

The V2 adapter translates execution, permission, and form events into the
shared tracker's private event format. It scopes the server-wide stream to the
plugin's loaded directory and workspace. Read-only session lookups recover
ancestry for resumed sessions, with an independent one-second deadline because
the V2 in-process context may ignore client cancellation options. Events and
session metadata are reduced to identifiers, location, and activity state;
model content, answers, and raw errors are not logged.

If the V2 subscription fails or ends unexpectedly, the plugin releases its
lease and prints an advisory to reload the plugin. It does not reconnect with
stale activity state. Observation begins at setup: execution already running
during a reload can reacquire protection at its next observed model step, but
immediate reconstruction of active work is not implemented. A silently stalled
stream cannot be detected by this event-only adapter. Cleanup aborts observation
and releases protection immediately, including during a pending session lookup.
OpenCode V2 can retain an old location generation while a request is in flight
across a configuration reload. Its protection remains active until execution
finishes or is interrupted and the old generation can unload.

On Windows, the same OpenCode plugin holds a PowerShell lease that calls
`SetThreadExecutionState` with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` during
active work, then clears it when work pauses or finishes. It does not request
that the display stay on. User verification is described in
[README.md](README.md#verify-protection). The Windows backend uses the built-in
`powershell.exe` and adds no npm dependencies. The test suite parses the helper
with PowerShell when run on Windows.

## Codex Linux portal integration checks

On a GNOME desktop, `npm run test:gnome` checks that the supervisor's native
inhibitor follows active work, approval waits, resumed work, concurrent
threads, completion, and supervisor crashes. The supervisor owns the portal
connection directly, so a killed supervisor releases the request when its
session-bus connection closes.

To hold the real inhibitor beyond Automatic Suspend, set
`CODEX_KEEP_AWAKE_GNOME_HOLD_MS` to a duration in milliseconds longer than the
configured AC timeout. The integration test checks that duration against
`gsettings` and verifies that GNOME continues to list the native inhibitor
throughout. This is a timed hold check; it does not issue suspend or change
power settings.

## Runtime design and compatibility

Concurrent Codex threads and subagents share one supervisor and inhibitor;
OpenCode sessions share the desktop inhibitor while any session remains active.

Normal daemon discovery uses `codex app-server daemon version`.
`CODEX_KEEP_AWAKE_SOCKET` overrides the socket path for isolated probes or
diagnostics. Treat `Stop` as a completion hint: another hook can continue work,
and observed app-server status remains authoritative when available.

With the normal app-server daemon, the observer reads thread status once per
second and releases protection for `waitingOnApproval` and
`waitingOnUserInput`. It uses read-only `thread/read` requests with
`includeTurns: false`; see the [Codex app-server
protocol](https://learn.chatgpt.com/docs/app-server).

The observer connects to the local Unix socket through Node's native WebSocket
client and a small HTTP transport adapter. Compression is disabled and incoming
messages are limited to 1 MiB. The supported Node range is `^24.17.0`, which
provides the native client's message-size controls; other major versions
require separate validation.

Codex supplies the hooks' private state directory as `PLUGIN_DATA`. Use that
same directory with `--data-dir` for inspection or cleanup. The `status` command
emits JSON describing the supervisor, registered threads, observation status,
and inhibitor state. The `cleanup` command clears registrations, signals the
supervisor to exit, and releases the inhibitor; a later hook can start it again.

Existing dependency-install files from an earlier version are no longer used.
The old `setup` command remains compatible: it only creates the state directory
and reports that no separate runtime dependency installation is needed.

The Codex and OpenCode Linux integrations use the same in-process XDG Desktop
Portal client and request suspend inhibition only. `status` reports the backend as
`xdg-desktop-portal`, whether the portal accepted the request, and
`inhibitionVerified: false` because the public portal response does not confirm
that the selected desktop backend applied native inhibition. OpenCode also
supports its Windows execution-state backend; the macOS helper remains
inactive. The vendored D-Bus packages retain their original license notices and
upstream attribution in `node_modules/`.

On Linux, app registration is enabled only when an exact token in
`XDG_CURRENT_DESKTOP` or `XDG_SESSION_DESKTOP` identifies MATE (`mate`,
`ubuntu-mate`) or Cinnamon (`cinnamon`, `x-cinnamon`). Each new portal
connection checks `org.freedesktop.host.portal.Registry.version`; when it is
at least 1, the client creates or refreshes the marked
`io.github.vladlosev.CodexKeepAwake.desktop` file under the user's applications
directory, then calls `Registry.Register(sa{sv})` before `Inhibit` on that same
connection. A missing Registry API or version 0 keeps the existing Inhibit path
and creates no file. Explicit file preparation or registration failures close
the connection and use the normal retry policy with fixed sanitized messages.
Run `node --test test/portal-app-registration.test.js test/portal-inhibit.test.js`
for the focused coverage and `npm run validate:package` for the packed private
D-Bus checks. To confirm real XApp inhibition, inspect the session manager's
native inhibitor list during active work and after a wait or idle transition;
portal acceptance and `systemd-inhibit --list` alone do not establish that
XApp applied a session inhibitor.
