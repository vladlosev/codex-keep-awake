# OpenCode GitHub Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work inline unless the user requests delegation.

**Goal:** Make this GitHub repository installable as an OpenCode plugin on OpenCode `1.18.35` and `2.0.29`, without npm publication, a build step, or a manual dependency install.

**Architecture:** Move the existing dual-version default export into `src/opencode-entry.js`, expose it through the package's `./server` export, and retain the project-local discovery file as a re-export. Both installation routes will use the same V1 hooks, V2 adapter, activity tracker, and native backends. Validate the packed artifact and both real installers before checking the updated revision through GitHub.

**Tech Stack:** JavaScript ES modules, Node.js `^24.17.0`, npm package exports and packing, OpenCode V1/V2 plugin installers, Node's built-in test runner, Jujutsu for this checkout.

**Spec:** The user's request to plan GitHub installation for both OpenCode versions, made concrete in [Design and acceptance contract](#design-and-acceptance-contract). The existing [dual-version support plan](2026-10-15-opencode-dual-version-support.md) supplies the runtime behavior contract; this change concerns distribution.

## Global constraints

- Preserve Node.js `^24.17.0`, plugin ID `codex-keep-awake`, and the current package/version and Codex manifests.
- Test OpenCode `1.18.35` and `2.0.29`; these are explicit baselines, not a claim that every V1/V2 release works.
- Keep V1 `server()` and V2 `setup(ctx)` on one default-exported object. Importing it must not start an inhibitor or require an OpenCode API package.
- Add no runtime npm dependency, npm publication requirement, lifecycle installation script, or build/prepare step. `ws@8.22.0` remains development-only.
- Preserve activity/wait/ancestry rules, location scoping, cleanup, GNOME suspend-only behavior, Windows support, and inactive macOS behavior.
- Preserve project-local discovery at `.opencode/plugins/codex-keep-awake.js` and existing Codex CLI/hook behavior.
- Keep README focused on distributed Codex usage. Put OpenCode user installation in `docs/opencode.md`, linked from `AGENTS.md`; keep development/testing details in `AGENTS.md`.
- Preserve the dirty working copy, including the existing V2 implementation and its plan. Do not create a worktree, change bookmarks, split/describe the user's change, push, or publish as part of this plan.
- Use explicit paths to disposable OpenCode binaries and isolated HOME/XDG/config/cache directories. Do not update the user's installed plugins or contact a shared OpenCode service.
- Retain only sanitized versions, revisions, package/source paths, and check results. Do not retain credentials, prompts, model content, raw events, or raw exceptions.

## Design and acceptance contract

### Evidence and upstream interfaces

Checked on 2026-10-15:

- Both real CLIs fetched `github:vladlosev/codex-keep-awake` in disposable configurations. V1 stopped because `package.json` exposes no plugin entrypoint. V2 stopped with `Plugin package has no server or TUI entrypoint`. Neither successful download proves plugin activation.
- The checkout's dual-version implementation is already present but uncommitted. The implementation plan must build on those files rather than replace them with the older published entrypoint.
- [V1 package resolution](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/plugin/shared.ts) accepts `exports["./server"]` for its server plugin. [V1 loading](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/plugin/index.ts) accepts the existing object with `id` and `server()`.
- [V2 package resolution](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/host.ts) tries the installed package's `server` subpath before its root. [V2 loading](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/plugin/module.ts) requires a default definition with `id` and `setup` or `effect`.
- [V2 installation documentation](https://opencode.ai/v2/docs/plugins) supports GitHub/Git package specifications and uses `opencode plugin add`. Its config key is `plugins`; V1 uses `plugin` and `opencode plugin` without `add`.
- Both pinned installers disable lifecycle scripts: [V1 installer](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/core/src/npm.ts), [V2 installer](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/util/src/npm.ts). Ship directly usable JavaScript and helper files.

### Chosen approach

Use a canonical module under the already-packaged `src/` directory. Keep only this line in the project-local plugin file:

```js
export { default } from "../../src/opencode-entry.js";
```

Expose the canonical module in the root `package.json`:

```json
"exports": {
  "./server": "./src/opencode-entry.js"
}
```

No `main`, package-root export, TUI/RPC export, or new dependency is needed for the two verified loaders. The existing `files` entry `src/` includes the new module and its relative imports. Keep `.opencode/`, development dependencies, tests, and plan documents outside the distributed archive.

Alternatives considered: exporting the existing `.opencode/plugins/` file would require packaging a development discovery directory; separate V1/V2 packages or exports would duplicate distribution for adapters that already coexist. The canonical module keeps the package independent of checkout layout while preserving local discovery.

### Acceptance

1. `codex-keep-awake/server` resolves from an installed package and exports the existing ID plus both lifecycle methods.
2. A real npm archive installs and imports in a fresh consumer with no development dependencies or lifecycle scripts.
3. Both pinned OpenCode CLIs install a Git revision of the changed package and load it as a package plugin, without a project-local fallback.
4. Local discovery, existing behavior tests, and Codex package/CLI checks still pass.
5. User instructions distinguish V1/V2 commands and config keys, installation from activation, and distributed installation from this checkout's automatic discovery.
6. A final install of the updated revision through GitHub passes on both baselines when that revision becomes available remotely. Before publication, record this check as pending, separately from passing local artifact/Git checks.

### File map

| File | Action and responsibility |
| --- | --- |
| `src/opencode-entry.js` | Create; canonical dual-version default export, moved from the local discovery module. |
| `.opencode/plugins/codex-keep-awake.js` | Modify; re-export the canonical module for local discovery. |
| `package.json` | Modify; expose `./server` and add the artifact regression test to `validate:package`. |
| `test/opencode-loader.test.js` | Reuse unchanged; existing tests cover both local lifecycle methods and clean-copy imports after the re-export. |
| `test/package.test.js` | Modify; verify the package entrypoint is actually included in the archive and `.opencode/` remains excluded. |
| `test/opencode-package.test.js` | Create; install the real archive in a clean consumer and exercise both idle lifecycles. |
| `docs/opencode.md` | Create; practical V1/V2 GitHub installation and configuration instructions. |
| `AGENTS.md` | Modify; link OpenCode user instructions and document package layout and isolated verification. |
| This plan | Append sanitized implementation/verification evidence when executed. |

The existing CI already runs `npm test` and `npm run validate:package` on minimum and latest Node 24. Do not add a network-dependent OpenCode download to the regular test suite. `package-lock.json` should not need changes for exports/scripts alone; inspect any generated delta rather than regenerating dependencies unnecessarily.

## Task 1: Establish the canonical dual-version entrypoint

**Files:** Create `src/opencode-entry.js`; modify `.opencode/plugins/codex-keep-awake.js`. Reuse `test/opencode-loader.test.js`.

**Interfaces:** Consume `createOpenCodeBackend()`, `createOpenCodeHooks({ backend })`, and `setupOpenCodeV2(ctx, { backend })` unchanged. Produce one default object `{ id, server, setup }` shared by package and local discovery.

- [x] Run `node --test test/opencode-loader.test.js` as the baseline. The existing tests exercise V1 initialization/disposal, V2 subscription cleanup, and imports without API packages. Reuse them for this mechanical move; Task 2 adds the meaningful regression for the new installation behavior.
- [x] Create `src/opencode-entry.js` by moving the current default-exported object, with its imports adjusted to the same directory. Preserve both method bodies exactly:

```js
import { createOpenCodeBackend } from "./opencode-backend.js";
import { createOpenCodeHooks } from "./opencode-plugin.js";
import { setupOpenCodeV2 } from "./opencode-v2-plugin.js";

export default {
  id: "codex-keep-awake",
  async server() {
    const backend = createOpenCodeBackend();
    if (!backend) return { event() {}, dispose() {} };
    return createOpenCodeHooks({ backend });
  },
  setup(ctx) {
    const backend = createOpenCodeBackend();
    if (!backend) return () => {};
    return setupOpenCodeV2(ctx, { backend });
  },
};
```

- [x] Replace the project-local module with the one-line re-export above. Keep the existing clean-copy test copying the entire `src/` directory so it includes the canonical module, without installing `.opencode` dependencies.
- [x] Run `node --test test/opencode-loader.test.js test/opencode-plugin.test.js test/opencode-v2-plugin.test.js`; expect all applicable tests to pass. Review the scoped diff for accidental lifecycle changes.

## Task 2: Expose and test the installed package

**Files:** Modify `package.json` and `test/package.test.js`; create `test/opencode-package.test.js`.

**Interfaces:** Consume Task 1's canonical module. Produce the public import `codex-keep-awake/server`, reachable from the actual installed artifact.

- [x] Extend `test/package.test.js` to require the server export target to appear in the existing `npm pack --dry-run --json --ignore-scripts` file set. Assert that the target is a package-relative path and that the archive excludes `.opencode/`, `test/`, and `docs/superpowers/`. Preserve existing Codex manifest, helper-file, dependency, and obsolete-runtime assertions.
- [x] Add `test/opencode-package.test.js`. Pack once into a temporary directory with `npm pack --json --ignore-scripts --pack-destination <temporary-directory>`, parse the returned filename, and install that absolute archive path into a fresh consumer using:

```text
npm install --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund --package-lock=false --offline <absolute-archive-path>
```

Before installation, create the consumer's `package.json` with `{"private":true,"type":"module"}`. Use argument arrays with `spawnSync`, an explicit consumer `cwd`, bounded timeouts, a temporary npm cache, and cleanup registered with `t.after`. Keep the consumer outside the checkout so its `node_modules` cannot satisfy missing runtime imports. All artifacts must stay under the test's temporary directory.

- [x] In that consumer, run the following verification as a child Node process. Pass `consumer` as its working directory and put the program in a consumer-local `.mjs` file, so bare package resolution starts there:

```js
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";

const installedRoot = realpathSync("node_modules/codex-keep-awake");
const entry = realpathSync(fileURLToPath(import.meta.resolve("codex-keep-awake/server")));
assert.equal(entry, path.join(installedRoot, "src", "opencode-entry.js"));
const { default: plugin } = await import("codex-keep-awake/server");
assert.equal(plugin.id, "codex-keep-awake");
assert.equal(typeof plugin.server, "function");
assert.equal(typeof plugin.setup, "function");

const hooks = await plugin.server({});
assert.equal(typeof hooks.event, "function");
assert.equal(typeof hooks.dispose, "function");
hooks.dispose();
hooks.dispose();

if (["linux", "win32"].includes(process.platform)) {
  const ended = Promise.withResolvers();
  const cleanup = await plugin.setup({
    location: { directory: process.cwd() },
    event: {
      subscribe({ signal }) {
        const aborted = Promise.withResolvers();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        if (signal.aborted) aborted.resolve();
        return (async function* () {
          try { await aborted.promise; } finally { ended.resolve(); }
        })();
      },
    },
  });
  assert.equal(typeof cleanup, "function");
  cleanup();
  cleanup();
  await ended.promise;
}
```

The test supplies no active-work events, so no real inhibitor or desktop is required. A zero exit code checks the installed import graph, V1 initialization/disposal, and V2 subscription cleanup; existing activity/backend tests retain responsibility for event behavior.

- [x] Run the new test against the pre-export package; expect a package-subpath resolution failure. If necessary temporarily wire the new test directly with `node --test test/opencode-package.test.js` before changing the package script.
- [x] Add the `exports` object shown above. Keep the existing `bin`, Codex metadata, `files`, engines, and dependency versions. Set the validation script to:

```json
"validate:package": "node --test test/package.test.js test/opencode-package.test.js"
```

- [x] Run `npm run validate:package`; expect the packed consumer and the existing metadata/content checks to pass. Confirm no `.opencode` install or lifecycle execution was needed and no development dependency was installed in the consumer. Review the task's diff.

## Task 3: Verify both real Git installers and host loading

**Files:** No permanent host-test framework is required. Use disposable fixtures; record sanitized results in this plan and the development instructions in Task 4.

**Interfaces:** Consume Task 2's packed artifact. Exercise OpenCode's real package installation and host-loading interfaces, without changing the user's GitHub repository or global configuration.

- [x] Obtain/use separate released binaries for `1.18.35` and `2.0.29`, check `--version`, and record absolute paths. The current session used temporary public binaries; do not assume their paths persist. Inspect each pinned command's `--help` before invoking it.
- [x] Pack the changed checkout into a temporary directory, extract the archive into a new temporary plain Git repository, and commit the extracted package with fixture-only identity and disabled hooks/signing. Example commands for a Linux development host:

```sh
probe_root=$(mktemp -d /tmp/keep-awake-opencode-git.XXXXXX)
npm pack --ignore-scripts --pack-destination "$probe_root"
mkdir "$probe_root/package-repo"
tar -xzf "$probe_root/codex-keep-awake-0.1.0.tgz" \
  -C "$probe_root/package-repo" --strip-components=1
git -C "$probe_root/package-repo" init --initial-branch=main
git -C "$probe_root/package-repo" -c core.hooksPath=/dev/null add .
git -C "$probe_root/package-repo" -c core.hooksPath=/dev/null \
  -c commit.gpgsign=false -c user.name=Fixture \
  -c user.email=fixture@example.invalid commit -m 'Package fixture'
probe_revision=$(git -C "$probe_root/package-repo" rev-parse HEAD)
probe_spec="git+file://$probe_root/package-repo#$probe_revision"
```

Git commands here apply only to the disposable plain Git fixture. Continue using `jj` for the user's checkout. This tests the current artifact through the Git installer without publishing it or accidentally testing the older GitHub revision.

- [x] For each CLI, create a different disposable project and HOME/XDG/config/cache/state tree. Start from an environment allowlist: PATH/language/certificate settings, plus the current desktop D-Bus variables only when running the GNOME check. Do not inherit `OPENCODE_CONFIG*`, provider credentials, npm user config, Git credentials, or shared-server selectors. Disable auto-update/model catalog fetching using the pinned host's supported configuration. Run these commands through that isolated environment:

```sh
"$CODEX_KEEP_AWAKE_OPENCODE_V1_BIN" plugin -g "$probe_spec"
"$CODEX_KEEP_AWAKE_OPENCODE_V2_BIN" plugin add "$probe_spec"
```

Set each `CODEX_KEEP_AWAKE_OPENCODE_*_BIN` to its verified absolute binary path; do not use the global `opencode` executable. Assert exit zero, the expected config entry (`plugin` in V1; `plugins` in V2), and a cached package whose `./server` export resolves inside that cache. Confirm the fixture projects have no `.opencode/plugins/` fallback.

- [x] Launch each pinned host with its isolated environment using `serve --hostname 127.0.0.1 --port <reserved-loopback-port>`, without service/shared-daemon mode. Use a fresh temporary server password and keep it in memory only. Confirm readiness at V1 `/global/health` or V2 `/api/info`.
- [x] Use a local synthetic OpenAI-compatible provider, not personal configuration or a paid model, to run one controlled session per host. V1 config uses `provider.probe.npm = "@ai-sdk/openai-compatible"` and `provider.probe.options.baseURL`; V2 uses `providers.probe.package = "@opencode/ai/providers/openai-compatible"` and `providers.probe.settings.baseURL`. Point both at a loopback `/v1` endpoint with model `synthetic`; set `model` to `probe/synthetic`. Have the provider hold the main streaming response until initialization is verified, then send a synthetic completion and `[DONE]`. Answer auxiliary/title requests immediately or disable title generation using the version's supported agent setting.
- [x] In V1 create the session with `POST /session`, then start work with `POST /session/{id}/prompt_async` and a synthetic text part. In V2 use `POST /api/session` with `location.directory`, then `POST /api/session/{id}/prompt` with synthetic `text`. Assert the installed server module loads without entrypoint/import/definition errors. For V2 additionally query `/api/plugin?location[directory]=...` and require ID `codex-keep-awake`, active state, and package source. Keep request/response bodies and server passwords out of retained output.
- [x] On an available GNOME host, verify one package-backed busy/completed/host-shutdown sequence through the real inhibitor. Identify only this probe's lease processes by their installed `src/lease.js` path under its private cache, preserving any pre-existing Codex/OpenCode inhibitors. Check both the script path and inhibitor acquisition/release; a successful install or active inventory entry alone is insufficient evidence of suspend protection. Existing permission/question/concurrency suites cover the unchanged behavior in detail.
- [x] Stop and await all probe-owned hosts, providers, event readers, and lease children before removing their private directories. Retain only version, fixture revision, install/config result, installed module path, host activation result, and desktop check result. Record a missing GNOME/Windows prerequisite explicitly instead of treating it as a pass.

## Task 4: Document the two installation paths

**Files:** Create `docs/opencode.md`; modify the OpenCode sections of `AGENTS.md`. Leave `README.md` and the existing dual-version plan unchanged.

**Interfaces:** Consume the observed CLI commands and activation evidence. Produce user instructions that work after the updated code is available on GitHub, plus separate development verification instructions.

- [x] Create `docs/opencode.md` with prerequisites and the following version-specific command table. State that the commands require a GitHub revision containing the package export; the old published revision cannot install successfully.

| Baseline | Project installation | Global installation |
| --- | --- | --- |
| OpenCode `1.18.35` | `opencode plugin github:vladlosev/codex-keep-awake` | `opencode plugin -g github:vladlosev/codex-keep-awake` |
| OpenCode `2.0.29` | Configure the project `plugins` array below | `opencode plugin add github:vladlosev/codex-keep-awake` |

Manual configuration examples:

```json
{
  "plugin": ["github:vladlosev/codex-keep-awake"]
}
```

```json
{
  "plugins": ["github:vladlosev/codex-keep-awake"]
}
```

Label the first V1 and the second V2; instruct users to append to their existing array. V2's `plugin add` command installs globally by default; do not document a V1-style `-g` flag for it.

- [x] Explain that `#<full-commit-hash>` can select an exact Git revision, with a shell-quoted package specifier in commands. Do not invent a release tag. State that npm publication, `npm install`, a separate API package, and a manual build are unnecessary for plugin users.
- [x] State the inherited runtime prerequisites: GNOME needs Node `^24.17.0` on PATH and `gnome-session-inhibit`; Windows uses built-in `powershell.exe`; macOS remains unsupported. Explain starting a fresh OpenCode session after installation and checking actual protection/release using GNOME inhibitor listing or Windows `powercfg /requests`. These checks describe platform behavior; claim a tested platform only when evidence supports it.
- [x] Add a duplicate-install note: the repository already auto-loads its local wrapper. Use one installation route in this checkout, and perform global-install verification from a separate project. Do not introduce runtime deduplication or change plugin IDs to solve a development-only overlap.
- [x] Link the user document from `AGENTS.md`. Document the canonical `src/` entrypoint, `./server` export, re-export wrapper, artifact test, pinned CLI verification, and local-versus-GitHub evidence boundary there. Keep existing activity/lifecycle limitations and test guidance intact.
- [x] Verify every documented command against pinned help and Task 3 evidence. Do not imply the Codex `status` or `cleanup` commands manage OpenCode leases. Do not guess update/remove syntax that has not been checked.

## Task 5: Run required checks and record publication readiness

**Files:** Review the scoped changes and append evidence to this plan. Implementation is authorized; publishing and integration are outside the current request.

**Interfaces:** Consume Tasks 1–4. Produce a reviewable implementation with separate artifact, host, desktop, and remote-GitHub results.

- [x] Install root development dependencies before running checks:

```sh
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run validate:package
```

- [x] Verify the required suites on Node `24.17.0` and the current latest Node 24, locally using temporary binaries or through the existing CI matrix. Root installation remains sufficient; no `.opencode` dependency install is a prerequisite. Run `npm run test:opencode-gnome` when desktop prerequisites are satisfied, and keep its injected-event results separate from package-host results.
- [x] Inspect `jj status` and a diff scoped to the file map. Confirm the unrelated V2 work and existing user changes remain intact; no generated archive, private configuration, fixture Git metadata, logs, or dependencies have entered the working copy.
- [x] Record actual commands, Node/OpenCode versions, test totals, packed import/lifecycle result, each real Git install/host result, and any unavailable desktop/platform check. Do not mark this plan's implementation tasks complete while they are only planned.
- [x] Report the implementation as ready for review when local checks pass. Leave the final remote-GitHub check pending until the updated revision is available remotely through separately authorized publication.
- [x] After that revision is available, repeat each GitHub install in entirely fresh HOME/XDG/cache trees using the exact full commit hash and the commands below, then repeat the package-backed host activation check. Reuse the isolation/cleanup procedure from Task 3; empty caches prevent an older successful local install from masking a remote failure.

```sh
"$CODEX_KEEP_AWAKE_OPENCODE_V1_BIN" plugin -g \
  "github:vladlosev/codex-keep-awake#$published_revision"
"$CODEX_KEEP_AWAKE_OPENCODE_V2_BIN" plugin add \
  "github:vladlosev/codex-keep-awake#$published_revision"
```

Set `published_revision` from the actual remotely available implementation commit, not from the unrelated local fixture commit. This step verifies GitHub installation; it does not authorize a push, merge, tag, or release.

## Completion checklist

- [x] The local wrapper and installed package use the same canonical definition.
- [x] `./server` resolves from the archive installed without development dependencies or lifecycle scripts.
- [x] V1 and V2 real Git installation, configuration, and host loading pass with no local discovery fallback.
- [x] Required checks pass, Codex distribution is preserved, and desktop/platform limits are reported accurately.
- [x] OpenCode user/developer documentation matches the tested baselines and commands.
- [x] The original installation implementation at full GitHub revision `579ecf14b5d5673e60498e9497665d83f4095d6e` installs and activates on both baselines after the user published it. The later catalog-context correction remains local.

## Execution evidence

Implemented and verified on 2026-10-15 (America/Los_Angeles) in the original Jujutsu checkout. The existing V2 implementation is preserved. No worktree, bookmark, global plugin/configuration, remote repository, or publication state was changed. The only Git commits created were in disposable package fixtures outside the checkout.

| Check | Result |
| --- | --- |
| Root `npm ci --ignore-scripts --omit=optional --no-audit --no-fund` | Passed; no `.opencode` dependency installation. |
| Existing loader and V1/V2 lifecycle tests | 19 passed after moving the default export; both method bodies are unchanged. |
| New artifact/metadata regressions before implementation | Failed as expected: the package had no server export and its installed `server` subpath did not exist. |
| Full `npm test`, Node `24.17.0` | 82 passed, 1 Windows-only parser test skipped, 0 failures. |
| Full `npm test`, Node `24.22.0` | 82 passed, 1 Windows-only parser test skipped, 0 failures. This was the latest Node 24 in the official distribution index at verification. |
| `npm run validate:package`, Node `24.17.0` | 4 passed, including offline installation of the archive and V1/V2 idle lifecycle cleanup. |
| `npm run validate:package`, Node `24.22.0` | 4 passed with the same archive/lifecycle checks. |
| `npm run test:opencode-gnome` | 2 passed: injected events through V1/V2 both controlled the real GNOME inhibitor through work, permission/input waits, resumption, completion, and cleanup. |
| OpenCode `1.18.35`, real package Git installer | Passed with a full `git+file://` fixture revision, isolated global configuration, and no `.opencode` discovery fallback. |
| OpenCode `2.0.29`, real package Git installer | Passed with the same artifact/revision and an independent HOME/XDG/config/cache tree. |
| OpenCode `1.18.35`, real package host | Installed helper acquired GNOME inhibition during a synthetic request, then released it on completion; host shutdown left no fixture-owned lease. |
| OpenCode `2.0.29`, real package host | Inventory reported ID `codex-keep-awake`, state `active`, source type `package`. The installed helper acquired/released real inhibition during a synthetic request and host shutdown released all fixture-owned processes. |
| Existing Codex inhibitor | Preserved throughout package-host and injected-event GNOME checks. |
| Updated remote GitHub revision | Passed after the user published revision `579ecf14b5d5673e60498e9497665d83f4095d6e`; see the post-publication evidence below. |

The passing host probes packed the current runtime, extracted it into a disposable plain Git repository, committed fixture revision `bce6470e89079fc53b4bf460d700e0952a676445`, and ran the exact commands below through independent temporary environments:

```sh
/tmp/keep-awake-opencode-v1/opencode plugin -g "$probe_spec"
/tmp/keep-awake-opencode-v2/node_modules/@opencode/cli-linux-x64/bin/opencode plugin add "$probe_spec"
```

`probe_spec` was a full `git+file://` URL pointing to that fixture revision. V1 resolved `node_modules/codex-keep-awake/src/opencode-entry.js` under its private `cache/opencode/packages/` tree; V2 resolved the same package-relative module under its private `cache/opencode/npm/` generation. Both loaded the real package from separate projects without local source copies. The servers used private loopback listeners and synthetic model data. Credentials were generated in memory, and all fixture configuration, generated session data, and captured logs were deleted after hosts/providers/lease processes stopped. The sanitized result record was used to write this section.

Two verification details were resolved without changing runtime behavior:

1. V2 reports plugin state as `{ status: "active" }`, so the disposable probe checks `state.status` rather than comparing the whole object to a string. The corrected complete host probe passed for both versions.
2. The newer npm exported the parent user's `allow-scripts` policy into `npm_config_allow_scripts` during `npm run validate:package`. A nested fresh project install rejected that inherited environment policy with `EALLOWSCRIPTS`, even with `--ignore-scripts`. The artifact test now strips inherited `npm_config_*` values and supplies its own temporary cache and user/global configuration paths. The same test then passed with the npm bundled in both supported Node test versions.

Inline review confirmed the runtime change is limited to moving the existing entrypoint and replacing its former location with a re-export. The package export points into the existing `src/` archive contents. README, Codex manifests, dependency lockfile, activity logic, native backends, and the earlier dual-version plan were not changed. No runtime dependency, prepare/build script, version bump, or new OpenCode API package was added.

Remaining limits: live Windows power-request/parser checks need a Windows host and remain unverified; macOS stays inactive. The pre-existing `.opencode/package.json` module-type warning remains, and the minimum Node's npm warns about the user's newer `allow-scripts` setting before the isolated test starts. These do not affect the passing checks. Final remote installation was pending at this implementation checkpoint and was completed after the user published the revision, as recorded below. No publication was performed by the agent.

## Follow-up: OpenCode V1 command-menu advisory

On 2026-10-15, the user reported the V2 observation-failure advisory while
opening the command menu in OpenCode V1. The installed CLI was `1.19.0`.
The earlier session-only host checks had missed V1's internal V2 catalog
initialization path.

V1's [external-plugin loader](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/config/plugin/external.ts)
also discovers the local module's `setup()` method. Its
[Promise context](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/plugin/src/v2/promise/context.ts)
provides command/catalog transforms, but no activity-event subscription,
session lookup, or location API. Invoking the full V2 observer with that
context caused a local error and the advisory; the V1 `server()` activity
hooks use a separate path.

A disposable OpenCode `1.19.0` server reproduced the exact advisory after
loading `/api/command`, `/api/reference`, and `/command`. All three routes
returned HTTP 200. A temporary wrapper recorded only capability types:
`event.subscribe`, `session.get`, and `location` were absent;
`catalog.transform` and `command.transform` were functions. The unfixed
entrypoint printed the advisory once; the fixed entrypoint printed it zero
times under the same probe. No user configuration, prompts, answers, or raw
responses were retained.

The shared entrypoint now starts V2 observation only when
`ctx.event.subscribe` is callable. A public-entrypoint regression using the
actual V1 catalog-context shape failed with the advisory before the fix and
passed afterward. True V2 stream failure/EOF advisories remain covered and
unchanged.

Verification of this local fix:

| Check | Result |
| --- | --- |
| Full `npm test`, Node `24.17.0` | 83 passed, 1 Windows-only parser test skipped, 0 failures. |
| Full `npm test`, Node `24.22.0` | 83 passed, 1 Windows-only parser test skipped, 0 failures. |
| Package validation on both Node versions | 4 passed per version, including installed V1/V2 lifecycles. |
| Real OpenCode `1.19.0` package host | Full local Git fixture installation, busy/completion/shutdown inhibition, and absence of the advisory passed. |
| Real OpenCode `2.0.29` package host | The same checks passed; package inventory remained active. |

Both package hosts used fixture revision
`28c7b73832e7aba4274d87966fc82aadc8c0104f`, generated from the fixed packed
artifact. All private fixture state was removed after the hosts and helpers
stopped. The correction remains in the working copy until separately
published; the user's earlier push does not include it.

## Post-publication GitHub verification

After the user pushed the implementation, the GitHub API confirmed published
main revision `579ecf14b5d5673e60498e9497665d83f4095d6e`. Both pinned CLIs
installed that exact GitHub revision in new independent HOME/XDG/config/cache
trees using:

```sh
/tmp/keep-awake-opencode-v1/opencode plugin -g \
  github:vladlosev/codex-keep-awake#579ecf14b5d5673e60498e9497665d83f4095d6e
/tmp/keep-awake-opencode-v2/node_modules/@opencode/cli-linux-x64/bin/opencode plugin add \
  github:vladlosev/codex-keep-awake#579ecf14b5d5673e60498e9497665d83f4095d6e
```

OpenCode `1.18.35` and `2.0.29` both installed and loaded the actual GitHub
package, then acquired and released GNOME inhibition through their own cached
helper during a synthetic session and host shutdown. The V2 inventory reported
an active package source with the exact GitHub specifier. These probes used no
local discovery fallback or prepopulated package cache. All private host state
was removed after cleanup; the pre-existing Codex inhibitor was preserved.

This completes the original remote installation check. It verifies the
published installation implementation, not publication of the subsequent V1
catalog-context correction in this working copy.
