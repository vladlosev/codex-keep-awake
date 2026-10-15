# Codex Keep Awake

Codex Keep Awake prevents GNOME from suspending while Codex is doing active
work. It releases protection while Codex waits for approval or user input and
resumes protection when work resumes. The display may still blank and lock
normally.

The Codex baseline is version 0.160.0 with its normal local app-server daemon,
Node.js 24.17.0 or newer within the Node 24 series, and a GNOME Linux session
with `gnome-session-inhibit`. Ensure `node` on `PATH` meets this version
requirement. Other desktop environments are not supported.

## Install in Codex CLI

To install from a GitHub repository containing this marketplace, replace
`OWNER` with its account or organization:

```sh
codex plugin marketplace add OWNER/codex-keep-awake
codex plugin add codex-keep-awake@codex-keep-awake
```

Use `--ref` on `marketplace add` to select a branch or tag.
The [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
describes the CLI plugin browser and starting a new session after installation.

## Run the plugin

Start a new Codex CLI session, enter `/hooks`, then review and trust the
plugin's hook commands. Codex skips untrusted hooks. The
[hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook
review and trust in the CLI.

The first trusted hook starts the runtime automatically. No `npm install` or
`setup` command is required.

## Inspect and clean up

The plugin creates its private state directory automatically. With the default
plugin and marketplace names, it is normally
`~/.codex/plugins/data/codex-keep-awake-codex-keep-awake`; replace `~/.codex`
with your `CODEX_HOME` if customized.

Copy and paste this block to locate the installed plugin and inspect its
state. It reads the installed version from
[`codex plugin list --json`](https://learn.chatgpt.com/docs/cli/reference#codex-plugin)
and uses your `CODEX_HOME`, or `~/.codex` by default. It requires no additional
tools beyond Codex and Node.js:

```sh
keep_awake_home="${CODEX_HOME:-$HOME/.codex}"
keep_awake_version="$(
  codex plugin list --marketplace codex-keep-awake --json |
    node -e '
      const fs = require("node:fs");
      const plugin = JSON.parse(fs.readFileSync(0, "utf8")).installed
        .find(p => p.name === "codex-keep-awake");
      if (!plugin) {
        console.error("Install codex-keep-awake@codex-keep-awake first.");
        process.exit(1);
      }
      console.log(plugin.version);
    '
)"
keep_awake_root="$keep_awake_home/plugins/cache/codex-keep-awake/codex-keep-awake/$keep_awake_version"
keep_awake_data="$keep_awake_home/plugins/data/codex-keep-awake-codex-keep-awake"
node "$keep_awake_root/scripts/codex-keep-awake.js" status --data-dir "$keep_awake_data"
```

To clean up, run this command in the same terminal after the block above:

```sh
node "$keep_awake_root/scripts/codex-keep-awake.js" cleanup --data-dir "$keep_awake_data"
```

Both commands emit JSON describing the plugin's current state or the result of
cleanup.

`cleanup` stops the plugin's background process and releases suspend
protection. A later hook can start it again.

## Remove the plugin

Run `cleanup` as described above with the same data directory, then remove the
plugin from Codex CLI:

```sh
codex plugin remove codex-keep-awake@codex-keep-awake
codex plugin marketplace remove codex-keep-awake
```

Removing a plugin does not delete its private data directory. You can delete
that directory after cleanup has stopped the plugin.

## Operation and limits

With the normal app-server daemon, protection pauses automatically during
approval and input waits and resumes when work resumes. `status` reports
whether the plugin connected to Codex, whether automatic pause/resume is
available, and whether GNOME inhibition is active. An observation failure
after a successful connection releases protection after 60 seconds and
reports degraded status.

If Codex runs without the app-server daemon (for example, `--no-daemon`), hooks
provide turn-based protection, but automatic pause/resume during approval or
input waits is unavailable. `status` reports this limitation. Background jobs
that continue after a turn ends are not tracked.
