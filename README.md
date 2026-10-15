# Codex Keep Awake

Codex Keep Awake prevents GNOME from suspending while Codex or OpenCode is doing active work. It releases the inhibitor while Codex waits for approval or user input, and while an OpenCode session waits for permission or an answer. Protection resumes when work resumes. Concurrent Codex threads and subagents share one supervisor and inhibitor; OpenCode sessions share the desktop inhibitor while any session remains active.

The Codex baseline is version 0.160.0 with its normal local app-server daemon, Node.js 24.17.0 or newer within the Node 24 series, and a GNOME Linux session with `gnome-session-inhibit`. The runtime uses Node's built-in WebSocket client and has no npm dependencies to install. The project-local OpenCode plugin supports GNOME Linux first and Windows second. The display may still blank and lock normally. Other desktop environments are not supported by an active backend.

## Install from this checkout in Codex CLI

This repository includes a local marketplace in `.agents/plugins/marketplace.json`. In a terminal, add this checkout as a marketplace and install the plugin:

```sh
cd "/absolute/path/to/codex-keep-awake"
codex plugin marketplace add "$PWD"
codex plugin add codex-keep-awake@codex-keep-awake
```

Start a new Codex CLI session, enter `/hooks`, then review and trust the plugin's hook commands. Codex skips untrusted hooks. The [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins) describes the CLI plugin browser and starting a new session after installation; the [hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook review, trust, and plugin-bundled hooks in the CLI.

The first trusted hook starts the runtime automatically. No `npm install` or `setup` command is required. Ensure `node` on `PATH` meets the version requirement.

To install from a GitHub repository containing this marketplace, replace `OWNER` with its account or organization:

```sh
codex plugin marketplace add OWNER/codex-keep-awake
codex plugin add codex-keep-awake@codex-keep-awake
```

Use `--ref` on `marketplace add` to select a branch or tag. GitHub installation includes the runtime directly and does not require publishing to npm.

## Use from OpenCode CLI in this checkout

This checkout includes a project-local OpenCode V1 plugin in `.opencode/plugins/`. OpenCode loads it when started in this repository; no global plugin installation or configuration change is needed. From the repository root, run `opencode` for the TUI or use `opencode run` as usual.

Busy and retrying sessions prevent GNOME suspend. A session waiting for permission or an answer releases its own protection, including protection held for busy parent sessions; another active session keeps the inhibitor in place. Idle, failed, or deleted sessions release their protection. The display may still blank and lock normally.

On GNOME, the OpenCode integration requires Node.js 24.17.0 or newer within the Node 24 series on `PATH` and `gnome-session-inhibit`. Other Linux desktop environments are not supported by the active backend. Run `npm test` for the event and lifecycle checks, or `npm run test:opencode-gnome` on a GNOME desktop to verify that real D-Bus inhibition follows busy, permission-wait, resumed, and idle events. The test uses a distinct OpenCode inhibitor reason and leaves any Codex inhibitor alone.

On Windows, the same project-local plugin holds a PowerShell lease that calls `SetThreadExecutionState` with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` during active work, then clears it when work pauses or finishes. It does not request that the display stay on. During a live OpenCode session, `powercfg /requests` shows the active Windows power requests; check again after a permission wait or idle state to confirm the lease was released. The Windows backend uses the built-in `powershell.exe` and adds no npm dependencies. The test suite parses the helper with PowerShell when run on Windows.

## Inspect and clean up

Hooks create their private state directory automatically. Codex supplies this location as `PLUGIN_DATA`. With this repository's default plugin and marketplace names, it is normally `~/.codex/plugins/data/codex-keep-awake-codex-keep-awake`; replace `~/.codex` with your `CODEX_HOME` if customized.

For manual inspection, use that same directory with `--data-dir`. The following commands emit JSON describing the supervisor, registered threads, observation status, and inhibitor state, or the result of cleanup:

```sh
node "/absolute/path/to/codex-keep-awake/scripts/codex-keep-awake.js" status --data-dir "/path/to/the/plugin-data-directory"
node "/absolute/path/to/codex-keep-awake/scripts/codex-keep-awake.js" cleanup --data-dir "/path/to/the/plugin-data-directory"
```

`cleanup` clears registrations, signals the supervisor to exit, and releases the inhibitor. A later hook can start it again. To stop using the plugin, run `cleanup` with the same data directory, then remove it from Codex CLI:

```sh
codex plugin remove codex-keep-awake@codex-keep-awake
codex plugin marketplace remove codex-keep-awake
```

Removing a plugin does not delete its private data directory. You can delete that directory after the supervisor has stopped. Existing dependency files from an earlier version are no longer used. The old `setup` command remains compatible: it only creates the state directory and reports that there are no runtime dependencies to install.

## Operation and limits

With the normal app-server daemon, the observer reads thread status once per second and releases protection for `waitingOnApproval` and `waitingOnUserInput`. It uses read-only `thread/read` requests with `includeTurns: false`; see the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server). `status` reports whether the observer connected, whether automatic pause/resume is available, and whether GNOME inhibition is active. An observation failure after a successful connection releases protection after 60 seconds and reports degraded status.

The observer connects to the local Unix socket through Node's native WebSocket client and a small HTTP transport adapter. Compression is disabled and incoming messages are limited to 1 MiB. The supported Node range is `^24.17.0`, which provides the native client's message-size controls; other major versions require separate validation.

If Codex runs without the app-server daemon (for example, `--no-daemon`), hooks provide turn-based protection, but automatic pause/resume during approval or input waits is unavailable. `status` reports this limitation. Background jobs that continue after a turn ends are not tracked.

For development, run `npm ci --ignore-scripts --omit=optional --no-audit --no-fund` before `npm test` and `npm run validate:package`. The pinned `ws` package is a development dependency used only by test servers. CI tests the minimum Node version and the latest Node 24 release.

The regular test suite uses controlled app-server and inhibitor processes, including native WebSocket handshake, message, timeout, and cleanup checks. On a GNOME desktop, `npm run test:gnome` additionally checks real D-Bus inhibition while its test app-server reports active work, approval waits, resumed work, concurrent threads, completion, and supervisor crashes. To hold the real inhibitor beyond Automatic Suspend, set `CODEX_KEEP_AWAKE_GNOME_HOLD_MS` to a duration in milliseconds longer than the configured AC timeout. The integration test checks that duration against `gsettings` and verifies that GNOME continues to list the inhibitor throughout.

The Codex plugin currently enables GNOME inhibition. The OpenCode plugin enables GNOME and Windows inhibition; the macOS helper remains inactive. The original MIT notice and brief upstream attribution remain in [LICENSE](LICENSE) and the retained helper source.
