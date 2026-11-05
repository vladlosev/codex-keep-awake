# codex-keep-awake

A plugin that keeps your computer awake during active Codex CLI and OpenCode
work. It supports Codex CLI on Linux and OpenCode on Linux and Windows.

This project is a fork of
[claude-keep-awake](https://github.com/AxGord/claude-keep-awake) by
[AxGord](https://github.com/AxGord), adapted for Codex and OpenCode.

## Features

- Requests suspend inhibition while Codex or OpenCode is working
- Tracks active threads, subagents, and sessions
- Lets the display blank and lock normally
- Starts automatically; no separate npm installation is needed

## Requirements

- Codex CLI: the supported baseline is version 0.160.0 with its normal local
  app-server daemon
- OpenCode: see the [OpenCode instructions](#opencode) for compatible versions
- Node.js for Codex and OpenCode on Linux: 24.17.0 or newer within the Node 24
  series, with `node` on `PATH`
- Linux: a logged-in desktop session with a session D-Bus and an XDG Desktop
  Portal backend that supports suspend inhibition
- Windows for OpenCode: the built-in `powershell.exe`; live inhibition has not
  been verified on a Windows host

macOS is not supported.

## Linux desktop setup

If you use GNOME or KDE Plasma, no extra setup is required. For other desktop
managers, see [Linux desktop setup](docs/desktop-setup.md). The guide also
covers native inhibition checks, troubleshooting, and desktop-specific cleanup.

## Protection behavior

Codex and OpenCode request suspend inhibition while tracked work is active.
Protection pauses when work waits for approval, permission, or input, and
resumes when work continues. Another active tracked session keeps protection
in place. The display can still blank and lock normally. A successful portal
response alone does not prove that the desktop power manager applied the
inhibitor; use the desktop's native inhibitor view to confirm it.

## Codex CLI

### Quick start

1. Add the GitHub repository as a marketplace, then install the plugin:

   ```sh
   codex plugin marketplace add vladlosev/codex-keep-awake
   codex plugin add codex-keep-awake@codex-keep-awake
   ```

2. Start a new Codex CLI session, enter `/hooks`, then review and trust the
   plugin's hook commands. Codex skips untrusted hooks.
3. Start a task and [verify protection](#verify-protection).

See the [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
and [hook review instructions](https://learn.chatgpt.com/docs/hooks) for more
about installation and trust.

### Usage

The first trusted hook starts the background process automatically. Protection
follows [tracked activity](#protection-behavior); there is no separate setup
command to run. Exit Codex normally when finished so its background process can
stop when all registered sessions have ended.

### Update

Finish active work and exit your Codex sessions. Refresh this marketplace and
install its current plugin files:

```sh
codex plugin marketplace upgrade codex-keep-awake
codex plugin add codex-keep-awake@codex-keep-awake
```

Start a new Codex session and open `/hooks` to review and trust any changed
hooks. An update can require a new review even when the hook command is
unchanged; see [hook trust](https://learn.chatgpt.com/docs/hooks#plugin-bundled-hooks).
Then [verify protection](#verify-protection) during active work.

### Uninstall

Exit all Codex sessions normally so the shared background supervisor can stop.
If a crash or forced exit left it running, follow
[Codex recovery](#codex-recovery-after-a-crash-or-forced-exit) before removing
the plugin. Then run these commands from a terminal:

```sh
codex plugin remove codex-keep-awake@codex-keep-awake
codex plugin marketplace remove codex-keep-awake
```

The private state directory can remain after removal. Deleting it is optional;
with the default plugin and marketplace names, it is normally
`~/.codex/plugins/data/codex-keep-awake-codex-keep-awake`. Replace `~/.codex`
with your `CODEX_HOME` if customized. Delete it only after the background
supervisor has stopped. On MATE or Cinnamon, also see the
[desktop-entry cleanup instructions](docs/desktop-setup.md#remove-the-shared-desktop-entry).

### How it works

With the normal app-server daemon, protection pauses automatically during
approval and input waits and resumes when work resumes. An observation failure
after a successful connection releases protection after 60 seconds.

If Codex runs without the app-server daemon (for example, `--no-daemon`), hooks
provide turn-based protection, but automatic pause/resume during approval or
input waits is unavailable. Background jobs that continue after a turn ends
are not tracked.

### Codex recovery after a crash or forced exit

These optional steps stop a Codex background process left running after an
abnormal exit. Close all Codex sessions first and keep the plugin installed
until recovery is complete. The commands below manage Codex registrations;
OpenCode recovery is described [separately](#opencode-2-observation-stopped).

Find the installed plugin version:

```sh
codex plugin list --marketplace codex-keep-awake --json
```

In the `installed` list, find `codex-keep-awake@codex-keep-awake` and its
`version`. Replace `VERSION` in the following path with that value, then check
the background process:

```sh
plugin_script="${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-keep-awake/codex-keep-awake/VERSION/scripts/codex-keep-awake.js"
node "$plugin_script" status
```

This uses the installed plugin and requires no development checkout or global
npm installation. In the JSON output, `running` reports whether the recorded
background supervisor is alive. If it is, note `supervisor.pid` before cleanup.
`runtime.inhibitionVerified: false` is expected: the portal response does not
confirm native inhibition; use the [desktop checks](docs/desktop-setup.md#inhibition-checks)
to verify that separately.

Clear the registrations and request shutdown:

```sh
node "$plugin_script" cleanup
```

Cleanup clears the stored process record before the process finishes exiting.
If it was running, replace `PID` below with the supervisor PID you noted and
check until that supervisor command has exited:

```sh
ps -p PID -o pid=,args=
```

Once it has exited, you can uninstall the plugin and optionally delete its
state directory. If you keep the plugin, a later trusted hook starts it again;
[verify protection](#verify-protection) when you resume work.

## OpenCode

OpenCode 1 and 2 use different installation and configuration commands. Use
one installation route per project.

The installation commands below target OpenCode `1.18.35` and `2.0.29`. Use a
GitHub revision that includes the OpenCode package entrypoint; older revisions
without it fail with a missing plugin entrypoint error.

OpenCode downloads the plugin directly from GitHub. No separate `npm install`
or build command is needed.

### OpenCode 1

Install for the current project:

```sh
opencode plugin github:vladlosev/codex-keep-awake
```

Or install globally:

```sh
opencode plugin -g github:vladlosev/codex-keep-awake
```

For manual configuration, append the GitHub package to the `plugin` array in
your project's `opencode.json` or your global OpenCode configuration:

```json
{
  "plugin": ["github:vladlosev/codex-keep-awake"]
}
```

### OpenCode 2

Install globally:

```sh
opencode plugin add github:vladlosev/codex-keep-awake
```

For installation in one project, append the package to the `plugins` array in
that project's `opencode.json`:

```json
{
  "plugins": ["github:vladlosev/codex-keep-awake"]
}
```

OpenCode 2 uses `plugins` (plural), and `plugin add` installs globally by
default.

### Usage

Start a fresh OpenCode session after installation, then
[verify protection](#verify-protection) while it works. Protection starts and
stops automatically with [tracked activity](#protection-behavior).

### Update

Finish or interrupt active work before updating. Use the same configuration
scope as your installation and keep other plugin entries in place.

#### Update OpenCode 1

For a project installation, run this from that project:

```sh
opencode plugin --force github:vladlosev/codex-keep-awake
```

For a global installation:

```sh
opencode plugin -g --force github:vladlosev/codex-keep-awake
```

The `--force` option replaces the existing plugin version. Close and restart
the affected OpenCode processes so they load the updated package, then
[verify protection](#verify-protection).

#### Update OpenCode 2

For an unpinned package, update this plugin with:

```sh
opencode plugin update github:vladlosev/codex-keep-awake
```

Use the exact configured package specifier. The command accepts a target so
you can update this plugin without updating every installed plugin. For more,
see [OpenCode 2 plugin management](https://opencode.ai/v2/docs/plugins#manage).

Restart the OpenCode server that loaded the plugin. For OpenCode 2's local
background server, run:

```sh
opencode service restart
```

For a separately started server, stop and restart that server process. Reopen
your OpenCode session and [verify protection](#verify-protection).

#### Pinned revisions and manual configuration

To select an exact GitHub revision, replace the existing configuration entry
with `github:vladlosev/codex-keep-awake#FULL_COMMIT_HASH`, using the full hash of
the desired commit. Keep the `plugin` key for OpenCode 1 or `plugins` for
OpenCode 2, and preserve other settings. OpenCode 2's update command skips full
commit pins; change the configured hash to move to a different revision.
For OpenCode 1, use `--force` with the new specifier and the same project or
global scope. Restart the affected OpenCode host and verify protection.

### OpenCode 2 observation stopped

If the plugin reports:

```text
[Codex Keep Awake] OpenCode V2 observation stopped; reload the plugin to resume protection.
```

It has stopped tracking activity and released this plugin instance's sleep
protection. OpenCode may continue working. The plugin does not automatically
reconnect after this failure.

Finish or interrupt active work, then restart the OpenCode server using the
[restart instructions above](#update-opencode-2). Reopen your session and
[verify protection](#verify-protection) during new active work. Reloading the
plugin during work may take until its next observed model step to restore
protection.

### Uninstall

#### OpenCode 1

OpenCode 1 has no plugin removal command. Remove
`"github:vladlosev/codex-keep-awake"` from the `plugin` array in the configuration
where you installed it:

- Project installation: the project's `opencode.json` or `opencode.jsonc`.
- Global installation: `~/.config/opencode/opencode.json` or
  `~/.config/opencode/opencode.jsonc`, or the equivalent file in your custom
  OpenCode configuration directory.

If you pinned a revision, remove the entry including its `#revision` suffix.
Keep other plugins and settings in place. If installed both globally and in a
project, remove both entries.

#### OpenCode 2

Remove a global installation with:

```sh
opencode plugin remove github:vladlosev/codex-keep-awake
```

Use the exact configured package specifier, including any `#revision` suffix.
For a project installation, remove the entry from the `plugins` array in that
project's `opencode.json` or `opencode.jsonc`; the command only changes global
configuration. If installed in both places, remove both entries. See the
[OpenCode 2 plugin management documentation](https://opencode.ai/v2/docs/plugins#manage).

After removal, close and reopen affected OpenCode instances to release
protection held by an already loaded copy. Use the
[protection checks](#verify-protection) to confirm the OpenCode power request has
disappeared. Cached package downloads can remain; deleting them is not required
to stop loading the plugin.

On MATE or Cinnamon, also see the
[desktop-entry cleanup instructions](docs/desktop-setup.md#remove-the-shared-desktop-entry).

Development and test guidance is in
[AGENTS.md](AGENTS.md#opencode-development-and-compatibility).

## Verify protection

After installation or recovery, check while Codex or OpenCode is actively
working, during an approval or input wait, and after completion. The host's
inhibitor should appear during active work and disappear when it has no other
tracked work requiring protection. See [protection behavior](#protection-behavior)
and Codex's [daemonless limitations](#how-it-works) for the expected lifecycle.

On Linux, use the [desktop-specific verification commands](docs/desktop-setup.md#inhibition-checks)
in another terminal in the same desktop session. Look for the matching reason:

- Codex: `Codex is running active work`
- OpenCode: `OpenCode is running active work`

Other hosts or applications may keep their own inhibitors active. A successful
portal response alone does not verify that the desktop applied inhibition.

### OpenCode on Windows

Run this command during active work and again during a wait or after completion:

```powershell
powercfg /requests
```

Active work holds a system power request; a wait or idle state releases it when
no other tracked session remains active. The plugin does not request that the
display stay on.

## License

[MIT](LICENSE)
