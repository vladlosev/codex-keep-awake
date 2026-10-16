# OpenCode installation and removal

Keep Awake prevents automatic suspend during active OpenCode work. Protection
pauses while a session waits for permission or an answer and ends when work
finishes. Another active session keeps protection in place. The display can
still blank and lock normally.

The installation commands below target OpenCode `1.18.35` and `2.0.29`. Use a
GitHub revision that includes the OpenCode package entrypoint; older revisions
without it fail with a missing plugin entrypoint error.

## Requirements

- GNOME Linux: Node.js `24.17.0` or newer within the Node 24 series
  (`^24.17.0`) on `PATH`, plus `gnome-session-inhibit`.
- Windows: the built-in `powershell.exe`.

Other Linux desktop environments and macOS are unsupported. Live Windows
inhibition has not been verified on a Windows host.

OpenCode installs the package directly from GitHub. No npm publication,
separate `npm install`, OpenCode API package, or build command is required.

## OpenCode 1

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

## OpenCode 2

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

## Select an exact revision

Append `#` followed by a full Git commit hash to the package specifier to select
that revision. For example, after setting `revision` to the desired full hash,
use one of these commands:

```sh
opencode plugin -g "github:vladlosev/codex-keep-awake#$revision"
```

```sh
opencode plugin add "github:vladlosev/codex-keep-awake#$revision"
```

The first command is for OpenCode 1; the second is for OpenCode 2. The selected
revision must include the package entrypoint and the adapter for your version.

## Verify protection

Start a fresh OpenCode session after installation. Check while OpenCode is
actively working, then check again during a permission/input wait or after
completion.

On GNOME:

```sh
gnome-session-inhibit --list
```

Active work adds an inhibitor with the reason `OpenCode is running active
work`. It disappears when no tracked session requires protection. Any separate
Codex inhibitor can remain active.

On Windows:

```powershell
powercfg /requests
```

Active work holds a system power request; a wait or idle state releases it when
no other tracked session remains active. The plugin does not request that the
display stay on.

## Uninstall

### OpenCode 1

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

### OpenCode 2

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

Choose one installation route per project. Development and test guidance is in
[AGENTS.md](../AGENTS.md#opencode-development-and-compatibility).
