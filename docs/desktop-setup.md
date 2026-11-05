# Linux desktop setup, inhibition checks, and cleanup

This guide covers desktop-specific configuration, native inhibitor checks,
troubleshooting, and cleanup shared by Codex CLI and OpenCode. Host
installation and removal instructions are in [README.md](../README.md).

## Desktop support

GNOME and KDE Plasma require no extra setup beyond the plugin's normal
[requirements](../README.md#requirements). Other desktops need a portal backend
that supports suspend inhibition; MATE's setup is described below.

The portal selects the backend configured for the session. Source analysis
identifies suspend-capable backends for GNOME, KDE Plasma, Cinnamon, and MATE;
live lifecycle verification has been performed on GNOME, KDE Plasma, Cinnamon,
and MATE. The examined Xfce portal backend does not support suspend inhibition.
Manual suspend remains subject to desktop policy.

## Inhibition checks

Run the command for your current desktop in another terminal in the same
session. Check while work is active, then again during an approval,
permission, or input wait and after completion.

Look for the reason `Codex is running active work` or
`OpenCode is running active work`. The host's inhibitor should disappear when
it has no other active tracked work; other sessions or applications may still
hold their own inhibitors. The display can still blank and lock normally.

These commands check native inhibitors. A successful portal response alone
does not verify that the desktop power manager applied inhibition.

### GNOME, MATE, and Cinnamon

```sh
gnome-session-inhibit --list
```

Look for `(suspend)` beside the reason. On MATE and Cinnamon, also expect app
ID `io.github.vladlosev.CodexKeepAwake`.

#### MATE notes

An absent plugin entry in `systemd-inhibit --list` alone does not mean MATE
inhibition failed. Use the native session listing above.

If `gnome-session-inhibit` is unavailable, query MATE's session manager
directly:

```sh
gdbus call --session \
  --dest org.gnome.SessionManager \
  --object-path /org/gnome/SessionManager \
  --method org.gnome.SessionManager.IsInhibited 4
```

`(true,)` means at least one application is inhibiting suspend; `(false,)`
means none is. This checks the whole session, so it cannot identify which
application holds the inhibitor. MATE uses the `org.gnome.SessionManager`
API name, and flag `4` means suspend. If the expected inhibitor does not
appear, see [Troubleshoot MATE inhibition](#troubleshoot-mate-inhibition).

### KDE Plasma

Query PowerDevil's native active inhibitors from a terminal in the Plasma
session:

```sh
busctl --user get-property \
  org.kde.Solid.PowerManagement.PolicyAgent \
  /org/kde/Solid/PowerManagement/PolicyAgent \
  org.kde.Solid.PowerManagement.PolicyAgent ActiveInhibitions
```

Look for a `sleep` entry with one of the reasons above.

On older Plasma versions without the `ActiveInhibitions` property, list the
application names and reasons instead:

```sh
busctl --user call \
  org.kde.Solid.PowerManagement.PolicyAgent \
  /org/kde/Solid/PowerManagement/PolicyAgent \
  org.kde.Solid.PowerManagement.PolicyAgent ListInhibitions
```

These queries use the [PowerDevil D-Bus interface](https://github.com/KDE/powerdevil/blob/v6.6.6/daemon/dbus/org.kde.Solid.PowerManagement.PolicyAgent.xml),
which provides KDE Plasma's native inhibitor view.

## MATE and Cinnamon desktop entry

On MATE and Cinnamon, the plugin registers its identity through the portal's
Registry API when available, using a hidden per-user desktop entry. Codex Keep
Awake has an identity independent of Codex's app ID, and Codex and OpenCode
share the entry. It remains after a work session ends. The file is
`${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.vladlosev.CodexKeepAwake.desktop`.

### Remove the shared desktop entry

After uninstalling any Codex or OpenCode integrations that use it and closing
their running instances, you can remove the MATE/Cinnamon desktop entry. Check
its generated-file marker before deleting it so an unrelated file with the
same name is preserved:

```sh
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
desktop_entry="$applications_dir/io.github.vladlosev.CodexKeepAwake.desktop"
if [ -f "$desktop_entry" ] && grep -Fxq 'X-Codex-Keep-Awake-Generated=true' "$desktop_entry"; then
  rm -- "$desktop_entry"
fi
```

## MATE

### Enable MATE suspend inhibition

On Ubuntu MATE, install the XApp portal backend if it is not already
installed:

```sh
sudo apt install xdg-desktop-portal-xapp
```

Select XApp for suspend inhibition in your user MATE portal configuration.
The following variables use your custom `XDG_CONFIG_HOME` when set:

```sh
portal_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/xdg-desktop-portal"
portal_config="$portal_config_dir/mate-portals.conf"
```

#### If the configuration file already exists

Back it up before editing. The `-i` option asks before replacing an existing
backup; choose another backup name if you need to preserve an earlier copy:

```sh
cp -p -i -- "$portal_config" "$portal_config.before-keep-awake"
```

In the file's existing `[preferred]` section, add or change only this line:

```ini
org.freedesktop.impl.portal.Inhibit=xapp
```

Create the `[preferred]` section if it is absent. Keep all other settings,
including any existing `default` and `Secret` preferences.

#### If the configuration file does not exist

Create the directory:

```sh
mkdir -p -- "$portal_config_dir"
```

Create `mate-portals.conf` in that directory with this configuration:

```ini
[preferred]
default=gtk
org.freedesktop.impl.portal.Inhibit=xapp
org.freedesktop.impl.portal.Secret=gnome-keyring
```

Here, GTK handles interfaces without an explicit choice, XApp handles suspend
inhibition, and GNOME Keyring handles stored secrets. If your distribution's
MATE portal configuration specifies additional preferences, carry those into
the new file too; a user configuration can override the system configuration.

#### Apply the configuration

After logging into MATE, restart the XApp backend and portal frontend so XApp
connects to MATE's running session services. Run these commands as your desktop
user, without `sudo`:

```sh
systemctl --user restart xdg-desktop-portal-xapp.service
systemctl --user restart xdg-desktop-portal.service
```

The [portal configuration reference](https://flatpak.github.io/xdg-desktop-portal/docs/portals.conf.html)
describes backend selection and configuration-file precedence.

After setup, follow [Inhibition checks](#inhibition-checks) to verify the
native request.

### Undo the MATE portal configuration change

If you edited an existing file and have made no other changes since setup,
restore the backup below. Use your chosen backup filename if you used another
name. If you changed other preferences after making the backup, restore only
the old Inhibit preference by hand so those later edits are preserved.

```sh
portal_config="${XDG_CONFIG_HOME:-$HOME/.config}/xdg-desktop-portal/mate-portals.conf"
cp -p -i -- "$portal_config.before-keep-awake" "$portal_config"
```

If you created the file during setup, inspect it first. If it still contains
only this setup's configuration, remove it to restore system defaults:

```sh
portal_config="${XDG_CONFIG_HOME:-$HOME/.config}/xdg-desktop-portal/mate-portals.conf"
rm -i -- "$portal_config"
```

Restart the XApp backend and portal frontend using the commands under
[Apply the configuration](#apply-the-configuration). Keep the XApp package if
other applications use it. Removing this portal override is separate from
[removing the plugin's shared desktop entry](#remove-the-shared-desktop-entry).

### Troubleshoot MATE inhibition

First check while work is busy, rather than waiting for permission or input.
After updating the plugin, start fresh Codex/OpenCode instances so they load
the updated files. In Codex, also check `/hooks` and trust the plugin's hook
commands. Run the checks from your logged-in MATE session; the host's
`XDG_CURRENT_DESKTOP` or `XDG_SESSION_DESKTOP` must identify MATE for automatic
app registration.

Check recent errors while reproducing the problem:

```sh
journalctl --user -b --since '10 minutes ago' --no-pager \
  -u xdg-desktop-portal.service \
  -u xdg-desktop-portal-xapp.service -n 50
```

| Symptom or error | What to check |
| --- | --- |
| `Inhibiting other than idle not supported` | An idle-only backend path is being used. Confirm the Inhibit override selects `xapp`. XApp can also enter this fallback if it started before MATE's session services were available; restart both services as shown above after logging into MATE, then retry active work. |
| `Application ID not specified` | Ensure the loaded plugin includes MATE app registration. Check that the portal supports Registry and that the generated desktop entry described above exists. Update the plugin/portal as needed and restart the affected Codex/OpenCode instances. |
| `The Codex Keep Awake desktop identity entry could not be prepared` | Check ownership and write permissions in your XDG applications directory. A pre-existing unmarked file at the same desktop-entry path is preserved; inspect and resolve that conflict without overwriting your own entry. |
| Cannot connect to the session bus, or `org.gnome.SessionManager` is unavailable | Run the commands as the logged-in desktop user from MATE. A root shell, SSH session, or terminal from a different desktop may not have access to the same session services. |

To check portal Registry support:

```sh
gdbus call --session \
  --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  --method org.freedesktop.DBus.Properties.Get \
  org.freedesktop.host.portal.Registry version
```

Expect `(<uint32 1>,)` or a later version. A missing interface means the portal
frontend lacks the Registry API needed for this app-identity path. Upgrade to
a portal package that provides it. If the native inhibitor is present but
automatic suspend still occurs, inspect MATE's power-management settings and
logs; portal acceptance alone does not verify that power policy honored it.

