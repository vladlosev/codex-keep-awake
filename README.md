# codex-keep-awake

A plugin that keeps your computer awake during active Codex CLI and OpenCode
work. Codex and OpenCode use the XDG Desktop Portal suspend-inhibit API on
Linux; OpenCode also supports Windows.

This project is a fork of
[claude-keep-awake](https://github.com/AxGord/claude-keep-awake) by
[AxGord](https://github.com/AxGord), adapted for Codex and OpenCode.

## Features

- Requests suspend inhibition while Codex or OpenCode is working
- Tracks active threads, subagents, and sessions
- Lets the display blank and lock normally
- Starts automatically; its D-Bus client packages ship with the plugin

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

### Quick Start

Add the GitHub repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add vladlosev/codex-keep-awake
codex plugin add codex-keep-awake@codex-keep-awake
```

The [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
describes the CLI plugin browser and starting a new session after installation.

### Usage

Start a new Codex CLI session, enter `/hooks`, then review and trust the
plugin's hook commands. Codex skips untrusted hooks. The
[hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook
review and trust in the CLI.

The first trusted hook starts the runtime automatically. No separate npm
installation is required.

### Uninstall

Exit all Codex sessions normally so the shared background supervisor can stop,
then run these commands from a terminal:

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

### How It Works

With the normal app-server daemon, protection pauses automatically during
approval and input waits and resumes when work resumes. An observation failure
after a successful connection releases protection after 60 seconds.

If Codex runs without the app-server daemon (for example, `--no-daemon`), hooks
provide turn-based protection, but automatic pause/resume during approval or
input waits is unavailable. Background jobs that continue after a turn ends
are not tracked.

## OpenCode

OpenCode 1 and 2 use different installation and configuration commands. Use
one installation route per project.

The installation commands below target OpenCode `1.18.35` and `2.0.29`. Use a
GitHub revision that includes the OpenCode package entrypoint; older revisions
without it fail with a missing plugin entrypoint error.

OpenCode installs the package directly from GitHub. No npm publication,
separate `npm install`, OpenCode API package, or build command is required.

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

### Verify protection

Start a fresh OpenCode session after installation. Check while OpenCode is
actively working, then check again during a permission/input wait or after
completion. See the [protection behavior](#protection-behavior)
for the expected lifecycle.

On Linux, use the [desktop-specific verification commands](docs/desktop-setup.md#inhibition-checks).
Active work should add a native inhibitor with the reason `OpenCode is running
active work`. It disappears when no tracked session requires protection. Any
separate Codex inhibitor can remain active.

On Windows:

```powershell
powercfg /requests
```

Active work holds a system power request; a wait or idle state releases it when
no other tracked session remains active. The plugin does not request that the
display stay on.

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

## License

[MIT](LICENSE)
