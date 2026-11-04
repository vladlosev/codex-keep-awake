# Development guidance

Keep README.md focused on practical user instructions for installing, running,
inspecting, and removing the distributed Codex plugin. Put development guidance,
local-checkout workflows, and runtime implementation details in this file.

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
for normal operation, inspection, cleanup, and removal.

GitHub marketplace installation includes the runtime directly and does not
require publishing to npm.

## Try the terminal commands from this checkout

Install the package's CLI into npm's global command directory:

```sh
npm install --global --ignore-scripts .
```

The `codex-keep-awake status` and `codex-keep-awake cleanup` commands can then
run from any directory. They query `codex plugin list --json` and invoke the
active cached plugin version with its private data directory. Install the
Codex plugin separately using the local marketplace instructions above.

An explicit `--data-dir` argument or `PLUGIN_DATA` environment variable bypasses
discovery and operates directly on that directory. Tests must isolate both
`CODEX_HOME` and the default home-directory fallback when testing discovery.

## Install the distributed plugin in OpenCode

See [OpenCode installation and removal](docs/opencode.md) for GitHub installation
and uninstall instructions, version-specific configuration, prerequisites, and
protection checks. OpenCode V1 uses `plugin` and `opencode plugin`; V2 uses
`plugins` and `opencode plugin add`, which installs globally.

## OpenCode development and compatibility

This checkout does not automatically register the plugin in OpenCode. Use the
[GitHub installation instructions](docs/opencode.md) to enable it globally or
for a project. Tests import the package's canonical entrypoint directly.

OpenCode `1.18.35` and `2.0.29` are the compatibility baselines. The same default
export provides V1 `server()` hooks and V2 `setup(ctx)` with an event subscription
and cleanup function. The entrypoint imports no OpenCode API package; both
versions share the activity tracker and native backends. Root `npm ci` is enough
for the regular tests; installing dependencies inside `.opencode/` is not a test
prerequisite. Earlier V1 object entrypoints exist from `1.18.29`, but releases
below `1.18.35` have not been validated here.

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
provider. Confirm the cached package is loaded and its own helper acquires and
releases inhibition. Preserve pre-existing inhibitors and stop all probe-owned
processes before removing fixtures. The
[GitHub installation plan](docs/superpowers/plans/2026-10-15-opencode-github-installation.md)
records the procedure and results. Local archive/Git validation is separate
from installation of an updated remote GitHub revision, which requires that
revision to be available remotely.

Busy and retrying sessions request suspend inhibition through the XDG Desktop
Portal. A session waiting for
permission or an answer releases its own protection, including protection held
for busy parent sessions; another active session keeps the inhibitor in place.
Idle, failed, or deleted sessions release their protection. The display may
still blank and lock normally.

On Linux, OpenCode requires Node.js 24.17.0 or newer within the Node 24 series
on `PATH`, a session bus, and an XDG Desktop Portal backend that supports
suspend inhibition. The portal chooses the configured desktop backend. Source
analysis identifies support in GNOME, KDE Plasma, Cinnamon, and MATE backends;
live lifecycle verification has been performed on GNOME and Cinnamon. The
examined Xfce backend does not support suspend inhibition. Portal `Response=0`
means the portal accepted the request; it does not verify that the desktop power
manager applied a native inhibitor. The helper reports active only after that
response, retries unavailable requests every five seconds while work remains
active, and releases on idle, helper shutdown, or session-bus loss.

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
that the display stay on. During a live OpenCode session, `powercfg /requests`
shows the active Windows power requests; check again after a permission wait or
idle state to confirm the lease was released. The Windows backend uses the
built-in `powershell.exe` and adds no npm dependencies. The test suite parses
the helper with PowerShell when run on Windows.

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
