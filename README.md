# codex-keep-awake

A plugin that keeps your computer awake during active Codex CLI and OpenCode
work. Normal sleep behavior resumes while work waits for your approval or
input. Codex and OpenCode use the XDG Desktop Portal suspend-inhibit API on
Linux; OpenCode also supports Windows. The portal chooses the installed
desktop backend.

This project is a fork of
[claude-keep-awake](https://github.com/AxGord/claude-keep-awake) by
[AxGord](https://github.com/AxGord), adapted for Codex and OpenCode.

## Features

- Requests suspend inhibition while Codex or OpenCode is working
- Pauses protection during approval and input waits, then resumes with work
- Keeps protection active while any tracked thread, subagent, or session is working
- Allows the display to blank and lock normally
- Starts automatically; its D-Bus client packages ship with the plugin

### MATE and Cinnamon desktop entry

On MATE and Cinnamon, a portal that provides the Registry API also gets a
hidden, per-user desktop entry for the extension identity. Codex Keep Awake
uses its own identity, independent of Codex's app ID, and Codex and OpenCode
share this entry. It remains after a work session ends. The file is
`${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.vladlosev.CodexKeepAwake.desktop`.

### Enable MATE suspend inhibition

On Ubuntu MATE, install the XApp portal backend if it is not already
installed:

```sh
sudo apt install xdg-desktop-portal-xapp
```

Select XApp for the portal's Inhibit interface by adding these entries to
`~/.config/xdg-desktop-portal/mate-portals.conf`. Keep any other portal
preferences already in that file; the Secret entry below preserves MATE's
GNOME Keyring provider:

```ini
[preferred]
default=gtk
org.freedesktop.impl.portal.Inhibit=xapp
org.freedesktop.impl.portal.Secret=gnome-keyring
```

After logging into MATE, restart the XApp backend and portal frontend so XApp
connects to MATE's running session services:

```sh
systemctl --user restart xdg-desktop-portal-xapp.service
systemctl --user restart xdg-desktop-portal.service
```

In our MATE session, the portal had selected XApp but the backend reported
`Inhibiting other than idle not supported`. Restarting XApp after MATE's
session services were available cleared that failure, and MATE's session
manager received the suspend-inhibit request. During active work, check the
user journal for new portal errors if inhibition does not appear:

```sh
journalctl --user -b --no-pager \
  -u xdg-desktop-portal.service \
  -u xdg-desktop-portal-xapp.service -n 50
```

## Codex CLI

### Quick Start

Add the GitHub repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add vladlosev/codex-keep-awake
codex plugin add codex-keep-awake@codex-keep-awake
```

Use `--ref` on `marketplace add` to select a branch or tag.
The [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
describes the CLI plugin browser and starting a new session after installation.

### Usage

Start a new Codex CLI session, enter `/hooks`, then review and trust the
plugin's hook commands. Codex skips untrusted hooks. The
[hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook
review and trust in the CLI.

The first trusted hook starts the runtime automatically. No `npm install` or
`setup` command is required.

### Status and Cleanup

These terminal commands manage the Codex plugin only.

The plugin creates its private state directory automatically. With the default
plugin and marketplace names, it is normally
`~/.codex/plugins/data/codex-keep-awake-codex-keep-awake`; replace `~/.codex`
with your `CODEX_HOME` if customized.

For optional terminal commands, install the CLI from the same GitHub repository:

```sh
npm install --global --ignore-scripts --allow-git=all vladlosev/codex-keep-awake
```

Then run either command from any directory:

```sh
codex-keep-awake status
codex-keep-awake cleanup
```

The commands locate the active installed plugin automatically and use your
`CODEX_HOME`, or `~/.codex` by default. Codex must be on `PATH`, and the plugin
must already be installed. Both commands emit JSON describing the plugin's
current state or the result of cleanup.

`status` is read-only. `cleanup` resets the plugin's runtime bookkeeping and
asks its background process to stop and release suspend protection. It leaves
the private data directory in place. A later hook can start protection again.

### Uninstall

Run `cleanup` as described above with the same data directory, then remove the
plugin from Codex CLI:

```sh
codex plugin remove codex-keep-awake@codex-keep-awake
codex plugin marketplace remove codex-keep-awake
```

Removing a plugin does not delete its private data directory. You can delete
that directory after cleanup has stopped the plugin.

After uninstalling both integrations and closing their running instances, you
can remove the MATE/Cinnamon desktop entry. Check its generated-file marker
before deleting it so an unrelated file with the same name is preserved:

```sh
desktop_entry="${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.vladlosev.CodexKeepAwake.desktop"
if [ -f "$desktop_entry" ] && grep -Fxq 'X-Codex-Keep-Awake-Generated=true' "$desktop_entry"; then
  rm -- "$desktop_entry"
fi
```

If you installed the optional terminal commands, remove them with:

```sh
npm uninstall --global codex-keep-awake
```

### How It Works

With the normal app-server daemon, protection pauses automatically during
approval and input waits and resumes when work resumes. `status` reports
whether the plugin connected to Codex, whether automatic pause/resume is
available, whether the portal accepted the suspend request, and the selected
backend (`xdg-desktop-portal`). Portal acceptance does not verify that the
desktop's native power manager applied the inhibitor. An observation failure
after a successful connection releases protection after 60 seconds and
reports degraded status.

If Codex runs without the app-server daemon (for example, `--no-daemon`), hooks
provide turn-based protection, but automatic pause/resume during approval or
input waits is unavailable. `status` reports this limitation. Background jobs
that continue after a turn ends are not tracked.

## OpenCode

### Quick Start

Install globally using the command for your OpenCode version.

OpenCode 1:

```sh
opencode plugin -g github:vladlosev/codex-keep-awake
```

OpenCode 2:

```sh
opencode plugin add github:vladlosev/codex-keep-awake
```

Start a fresh OpenCode session after installation. The plugin starts
automatically; no separate `npm install` or `setup` command is required.
Choose one installation route per project. See
[OpenCode installation and removal](docs/opencode.md) for project-only
configuration, pinned revisions, and detailed removal instructions.

### Usage and Protection Checks

Busy and retrying sessions request suspend inhibition. Protection pauses while
a session waits for permission or an answer and ends when work finishes.
Another active session keeps protection in place.

On GNOME, check the native inhibitor while OpenCode is working, then again
during a wait or after completion:

```sh
gnome-session-inhibit --list
```

The inhibitor with reason `OpenCode is running active work` should appear
during active work and disappear when no tracked session needs protection. A
separate Codex inhibitor can remain active. Other desktops select their own
portal backend and may have a different native inhibitor viewer.

On Windows, check system power requests with:

```powershell
powercfg /requests
```

The OpenCode power request follows the same activity and wait states. The
display can still blank and lock normally on both platforms.

### Uninstall

For OpenCode 2 global installations:

```sh
opencode plugin remove github:vladlosev/codex-keep-awake
```

Use the exact installed package specifier, including any `#revision` suffix.
For OpenCode 1, remove that entry from the `plugin` array in your global
OpenCode configuration. Project installations require removing the entry from
the project's `plugin` (V1) or `plugins` (V2) array instead.

Close and reopen affected OpenCode instances after removal, then use the
protection checks above to confirm the OpenCode power request has disappeared.

## Requirements

- Codex CLI: the supported baseline is version 0.160.0 with its normal local
  app-server daemon
- OpenCode: compatibility baselines are versions 1.18.35 and 2.0.29
- Node.js for Codex and OpenCode on Linux: 24.17.0 or newer within the Node 24
  series, with `node` on `PATH`
- Linux: a logged-in desktop session with a session D-Bus and an XDG Desktop
  Portal backend that supports suspend inhibition
- Windows for OpenCode: the built-in `powershell.exe`; live inhibition has not
  been verified on a Windows host

The portal selects the backend configured for the session. Source analysis
identifies suspend-capable backends for GNOME, KDE Plasma, Cinnamon, and MATE;
live lifecycle verification has been performed on GNOME, KDE Plasma, Cinnamon,
and MATE. The examined Xfce portal backend does not support suspend inhibition.
Manual suspend remains subject to desktop policy. macOS is not supported.

## License

[MIT](LICENSE)
