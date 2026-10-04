# Convert keep-awake into a Codex plugin

## Summary

Replace the Claude implementation with a Codex implementation in `~/dev/codex-keep-awake`. Retain reusable code and regression scenarios, remove Claude-specific behavior, and make packaging and documentation describe Codex.

Use Node 18+, pinned `ws@8.22.0`, and Node built-ins. GNOME Linux is the first enabled backend. Preserve reusable macOS and Windows wake code as standalone helpers for future Codex support.

Protection must remain active during work, release during approval or input waits, and resume when execution continues. Registered threads and subagents share one supervisor and inhibitor.

## Stage 1 — Convert project identity and separate reusable code

**Deliverable:** Codex packaging and reusable native helpers without Claude lifecycle logic.

- Rename the npm package and plugin to `codex-keep-awake`, initially version `0.1.0`.
- Replace Claude manifests with `.codex-plugin/plugin.json` and a local Codex marketplace entry.
- Reuse `hooks/hooks.json` for Codex hooks; remove the need for parallel Claude and Codex hook files.
- Update distribution contents, descriptions, and installation instructions. Remove Claude marketplace links, npm badges, and unsupported platform claims.
- Remove the upstream npm publication workflow; publishing is outside this implementation.
- Preserve the original MIT notice and a brief upstream attribution. Remove misleading repository/homepage metadata until this fork has its own URL.

Retain and adapt:

- Path quoting, shared-supervisor coordination, owned-process cleanup, and relevant regression scenarios.
- macOS power assertions, power-management routines, and native cleanup.
- Windows `SetThreadExecutionState` code, extracted from the shell script into a standalone helper.

Give retained native helpers a common lifecycle: acquire protection on startup, hold while their stdin lease remains open, and restore normal behavior on EOF or termination. Pass paths explicitly; remove their Claude session monitoring, transcript parsing, and rate-limit logic. Keep these helpers inactive in the first release.

**Acceptance:** Codex metadata is consistent, retained helpers contain no Claude lifecycle dependencies, and their platform syntax/build checks pass.

## Stage 2 — Replace Claude hooks and session management

**Deliverable:** A Node runtime with advisory Codex hooks.

- Provide `setup`, `hook`, `status`, and `cleanup` commands.
- Prepare locked npm dependencies beneath `PLUGIN_DATA`, with optional native addons and installation scripts disabled.
- Run hooks offline. Missing dependencies produce an advisory message with the exact setup command.
- Parse stdin as JSON and track Codex thread, turn, and subagent identities.
- Handle `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, and `SessionEnd`.
- Use private state, atomic writes, exclusive filesystem locks, and process identity checks. Prevent duplicate supervisors and stale events clearing newer activity.
- Keep hooks within three seconds and return `{}` or an advisory `systemMessage`, without altering approval decisions.

Remove the superseded Claude scripts and mechanisms:

- `Notification`, `StopFailure`, and `AskUserQuestion` special handling.
- Claude process-name matching and state-directory defaults.
- Transcript interruption/error detection.
- Usage-limit settings, reset-time parsing, messaging sockets, and automatic continuation prompts.
- Claude background-task output tracking and status-line integration.

Codex hook events and trust requirements follow the [official hook documentation](https://learn.chatgpt.com/docs/hooks).

**Acceptance:** Concurrent hooks maintain correct registrations, start one supervisor per plugin data directory, and never invoke Claude behavior.

## Stage 3 — Observe Codex activity and implement GNOME inhibition

**Deliverable:** Protection that pauses and resumes with actual execution.

- Discover the existing daemon socket using `codex app-server daemon version`; support an explicit socket override.
- Connect through a Unix WebSocket using `ws`, initialize, and poll registered threads once per second.
- Use read-only `thread/read` requests with `includeTurns: false`.
- Require protection for active threads without waiting flags. Release that thread’s requirement during `waitingOnApproval` or `waitingOnUserInput`.
- Remove completed, unloaded, or failed registrations. Continue protecting independently active threads and subagents.
- Treat `Stop` as a completion hint because another hook can cause continuation.

Use a private backend interface with idempotent acquisition and release. Enable its GNOME implementation, launching `gnome-session-inhibit` with:

- Application ID `org.openai.Codex.KeepAwake`.
- Action `suspend`.
- Reason “Codex is running active work”.
- The Node lease command as its wrapped command.

Keep the lease’s stdin pipe open while protection is required. Closing it ends the command and releases GNOME inhibition; supervisor crashes also close it. Allow normal screen blanking and locking.

The observer uses the states documented by the [Codex app-server](https://learn.chatgpt.com/docs/app-server).

**Acceptance:** Protection follows observed state within two seconds, including resuming an approved command before its completion hook fires.

## Stage 4 — Replace legacy tests and verify recovery

**Deliverable:** A Codex regression suite and bounded failure recovery.

- Port relevant path-quoting, PID-reuse, interruption, and concurrent-session scenarios into Node’s built-in test runner.
- Remove tests specific to deleted Claude features.
- Use fake Unix WebSocket servers and inhibitor executables to test waits, resumed execution, subagents, repeated events, and Stop-hook continuation.
- Exercise stale locks, reused PIDs, duplicate startup, supervisor crashes, missing dependencies, malformed responses, and socket reconnection.
- Release protection after 60 seconds of unresolved observation failure and expose degraded status.
- For unobservable sessions such as `--no-daemon`, provide hook-based turn protection and explicitly report that automatic pause/resume during waits is unavailable.
- Record identifiers and transitions without recording prompts, commands, transcripts, or credentials.

**Acceptance:** Tests prove correct ownership, concurrency, and cleanup, including no orphaned inhibitor after a supervisor crash.

## Stage 5 — Validate the converted package and document operation

**Deliverable:** Reviewable implementation with installation and validation evidence.

- Replace Claude-specific CI checks with locked npm installation, Node tests, Codex hook/manifest validation, and package-content checks.
- Retain macOS compilation checks for the extracted helper; add Windows helper syntax validation without enabling either backend.
- Check distributed runtime files for obsolete Claude hooks, paths, environment variables, and invocation logic.
- Install and inspect the plugin in a disposable Codex configuration.
- Verify the real GNOME inhibitor during work, waits, completion, concurrent threads, and crashes.
- Rewrite the README around Codex setup, local installation, `/hooks` trust, status, cleanup, and removal. Identify retained native helpers as future integration work.
- Test active work beyond the Automatic Suspend timeout, explicitly recording any remaining manual verification.

**Defaults and boundaries:** Codex 0.160.0 with its normal local daemon is the initial baseline. Background jobs left running after a turn ends remain excluded. Cleanup concerns repository files; personal Claude installations and state are outside scope. Work stays in the current Jujutsu checkout, without publishing.
