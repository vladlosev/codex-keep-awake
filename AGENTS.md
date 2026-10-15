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
servers. The runtime uses Node's built-in WebSocket client and has no npm
dependencies to install. CI tests the minimum Node version and the latest
Node 24 release.

The regular test suite uses controlled app-server and inhibitor processes,
including native WebSocket handshake, message, timeout, and cleanup checks.

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

## Use from OpenCode CLI in this checkout

This checkout includes a project-local OpenCode V1 plugin in
`.opencode/plugins/`. OpenCode loads it when started in this repository; no
global plugin installation or configuration change is needed. From the
repository root, run `opencode` for the TUI or use `opencode run` as usual.

Busy and retrying sessions prevent GNOME suspend. A session waiting for
permission or an answer releases its own protection, including protection held
for busy parent sessions; another active session keeps the inhibitor in place.
Idle, failed, or deleted sessions release their protection. The display may
still blank and lock normally.

On GNOME, the OpenCode integration requires Node.js 24.17.0 or newer within the
Node 24 series on `PATH` and `gnome-session-inhibit`. Other Linux desktop
environments are not supported by the active backend. Run `npm test` for the
event and lifecycle checks, or `npm run test:opencode-gnome` on a GNOME desktop
to verify that real D-Bus inhibition follows busy, permission-wait, resumed,
and idle events. The test uses a distinct OpenCode inhibitor reason and leaves
any Codex inhibitor alone.

On Windows, the same project-local plugin holds a PowerShell lease that calls
`SetThreadExecutionState` with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` during
active work, then clears it when work pauses or finishes. It does not request
that the display stay on. During a live OpenCode session, `powercfg /requests`
shows the active Windows power requests; check again after a permission wait or
idle state to confirm the lease was released. The Windows backend uses the
built-in `powershell.exe` and adds no npm dependencies. The test suite parses
the helper with PowerShell when run on Windows.

## Codex GNOME integration checks

On a GNOME desktop, `npm run test:gnome` checks real D-Bus inhibition while its
test app-server reports active work, approval waits, resumed work, concurrent
threads, completion, and supervisor crashes.

To hold the real inhibitor beyond Automatic Suspend, set
`CODEX_KEEP_AWAKE_GNOME_HOLD_MS` to a duration in milliseconds longer than the
configured AC timeout. The integration test checks that duration against
`gsettings` and verifies that GNOME continues to list the inhibitor throughout.

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

Existing dependency files from an earlier version are no longer used. The old
`setup` command remains compatible: it only creates the state directory and
reports that there are no runtime dependencies to install.

The Codex plugin currently enables GNOME inhibition. The OpenCode plugin
enables GNOME and Windows inhibition; the macOS helper remains inactive. The
original MIT notice and brief upstream attribution remain in [LICENSE](LICENSE)
and the retained helper source.
