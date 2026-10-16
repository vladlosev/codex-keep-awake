# OpenCode Dual Version Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Work inline unless the user explicitly requests delegation.

**Goal:** Make the project-local Keep Awake plugin work with OpenCode V1 and V2 while preserving the existing activity and inhibition behavior.

**Architecture:** Keep one activity tracker and the existing GNOME and Windows backends. Preserve the V1 `server()` entrypoint and add a V2 `setup(ctx)` entrypoint to the same default export. Translate the small subset of V2 events relevant to inhibition into the tracker's existing private event format, and own the V2 subscription and cleanup in a separate adapter.

**Tech Stack:** JavaScript ES modules, Node.js `^24.17.0`, OpenCode's V1 hooks and V2 Promise plugin context, Node's built-in test runner, existing GNOME and PowerShell leases.

**Spec:** The accepted dual-adapter approach from the conversation, made concrete in [Design and acceptance contract](#design-and-acceptance-contract) below. Implementation and validation results are recorded in [Execution evidence](#execution-evidence).

## Global constraints

- Node.js stays `^24.17.0`; verify on `24.17.0` and the latest Node 24 release.
- Preserve plugin ID `codex-keep-awake` and project-local discovery at `.opencode/plugins/codex-keep-awake.js`.
- Verification targets are OpenCode `1.18.35` and `2.0.29`. Advertise these as tested baselines only after actual-host checks pass; do not claim every earlier or later release is verified.
- V1's object-entrypoint mechanism exists from `1.18.29`, but this work does not claim support below the checkout's existing `1.18.35` baseline without additional tests.
- Busy and retrying sessions require inhibition. Permission and user-input waits release the waiting session and its busy ancestors; an independently active sibling retains protection.
- Completion, failure, interruption, deletion, disposal, and failed V2 observation release the affected protection.
- Preserve GNOME suspend-only inhibition and Windows `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`; keep macOS inactive.
- Add no npm dependency to the Codex runtime and no manual dependency-installation step for OpenCode users. The pinned `ws@8.22.0` remains test-only.
- Keep local-checkout instructions, API compatibility details, and implementation notes in `AGENTS.md`; keep `README.md` focused on distributed Codex-plugin operation.
- Log fixed advisory messages only. Do not retain prompts, form answers, tool arguments, raw events, credentials, or raw exceptions.
- Use this existing Jujutsu checkout. Preserve unrelated changes. Do not create a worktree, alter bookmarks, publish, push, or install/replace a global OpenCode binary.
- Keep the existing root `PLAN.md` intact; it describes the earlier Codex conversion.

---

## Design and acceptance contract

### Verified upstream contracts

Sources checked on 2026-10-15. Use release-tagged source when implementing, rather than assuming that the development branch or a migration example is the complete wire contract.

- [Official plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/): one default export can contain V1 `server()` and V2 `setup()`; these require separate implementations.
- [V2 2.0.29 plugin definition](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/plugin.ts): a Promise plugin has `id` and `setup`, which can return synchronous or asynchronous cleanup. `define` returns its argument unchanged.
- [V2 event envelopes](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/event.ts): payload fields live in `event.data`, with optional `event.location`.
- [V2 execution and session events](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/session-event.ts): session creation exposes `sessionID` and `parentID`; native execution events describe start and terminal outcomes.
- [V2 permission events](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/permission.ts) and [form events](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/form.ts): permission waits retain their event names; user-input forms have separate create, reply, and cancel events. A form may have the non-session owner `global`, which must be ignored here.
- [V2 status compatibility events](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/session-status-event.ts): `session.status` still exists in this release; `session.idle` is deprecated. Prefer native execution events, but accept these status events idempotently.
- [V2 event API](https://opencode.ai/v2/docs/api#event): the stream spans server locations and is volatile; disconnection can lose events. Do not reconnect while retaining a possibly stale activity map.

### Boundaries

The first implementation observes live events from plugin setup onward. On unexpected stream failure or exhaustion, release this instance's lease, emit one fixed advisory, and require a plugin reload to resume observation. There is no polling loop, reconnection subsystem, persisted event history, or attempt to infer active work solely from stored session metadata. A stream that remains silent without reporting failure cannot be diagnosed by this event-only adapter; record that limit in `AGENTS.md`.

Preserve ancestry when an existing session is resumed: on the first activity or wait-start event for an unknown session, use the V2 context's read-only `session.get({ sessionID }, requestOptions)` to recover only its ID, parent ID, and location. A complete creation event can supply this metadata directly. Ignore terminal events and wait replies for untracked sessions; do not query a session that has just been deleted. This is metadata recovery, not activity reconstruction. Also recognize `session.step.started` so execution that continues after plugin reload can reacquire protection at its next model step. Immediate recovery of work already running at reload is outside this bounded change and must not be claimed in the documentation.

Each V2 plugin instance observes its own loaded location. Match `directory` and optional `workspaceID` against `ctx.location`; do not compare project ID alone. For a location-less event, use cached session metadata or a read-only lookup before accepting it. Ignore non-session forms, unrelated locations, and unsupported events. Treat `session.moved` as a routing control event: invalidate the tracked session's cached location and refresh its metadata. A session that moves out of this location must release its tracked requirement when its new location is observed. Do not let one instance's cleanup close another instance's backend.

### Event mapping

`normalizeOpenCodeV2Event(event)` returns one private tracker event or `null`. It copies only identifiers and state required by inhibition; it does not mutate or retain the input.

| V2 event | Private tracker event |
| --- | --- |
| `session.created` | `session.created`, `properties.info = { id: data.sessionID, parentID: data.parentID }` |
| `session.execution.started`, `session.step.started` | `session.status` with `busy` |
| `session.retry.scheduled` | `session.status` with `retry` |
| `session.execution.succeeded`, `.failed`, `.interrupted` | `session.idle` |
| `session.deleted` | `session.deleted` with `properties.sessionID` |
| `session.status` | `session.status`, copying only `sessionID` and `status.type` |
| `session.idle` | `session.idle` |
| `permission.asked` | `permission.asked`, copying `sessionID` and request `id` |
| `permission.replied` | `permission.replied`, copying `sessionID` and `requestID` |
| `form.created` | `question.asked`, using `data.form.sessionID` and `data.form.id` |
| `form.replied` | `question.replied`, using `data.sessionID` and `requestID: data.id` |
| `form.cancelled` | `question.rejected`, using `data.sessionID` and `requestID: data.id` |

Require nonempty string IDs for accepted events. Validate the relevant nested objects before reading them. Do not coerce unknown status values to busy or idle. Do not map tool completion or model-step completion to session completion: tools, further model steps, and retries can follow.

### File map

| File | Responsibility |
| --- | --- |
| `src/opencode-activity.js` | Shared activity rules; narrowly clear stale waits on terminal states. |
| `src/opencode-plugin.js` | Existing backend-driving hooks; make disposal idempotent and reject late events. |
| `src/opencode-v2-events.js` (new) | Pure V2-to-private-event normalization. |
| `src/opencode-v2-plugin.js` (new) | V2 stream ownership, location routing, bounded metadata reads, fixed failure advisories, cleanup. |
| `.opencode/plugins/codex-keep-awake.js` | Default export with both host entrypoints; backend creation stays lazy. |
| `test/helpers/opencode.js` (new) | Controlled async stream and recording backend shared by adapter tests. |
| `test/opencode-activity.test.js`, `test/opencode-plugin.test.js` | Existing policy and lifecycle regression tests. |
| `test/opencode-v2-events.test.js` (new) | Mapping, malformed-input, and data-minimization coverage. |
| `test/opencode-v2-plugin.test.js` (new) | Stream, routing, ancestry recovery, failure, and cancellation coverage. |
| `test/opencode-loader.test.js` | Both entrypoints and lazy import behavior. |
| `test/opencode-gnome-integration.test.js` | Real GNOME lease exercised through both API adapters, sequentially. |
| `package.json` | Add the new unit-test files to the explicit `npm test` command. |
| `test/package.test.js` | Require the two new source modules in the existing runtime-content check. |
| `AGENTS.md` | Supported/tested versions, operation, failure/reload behavior, checks and limits. |

The default export can remain a plain JavaScript object: the pinned V2 `define` helper has no runtime marker. Validate acceptance with both real loaders. Avoid importing `@opencode/plugin` just to construct this object, since an eager V2 import would also execute when V1 loads it. Keep `.opencode/package.json` and its existing V1 lockfile unchanged; there is no new API package import to install. The regular Node tests must continue to run after only the root dependency installation.

## Task 1: Make shared shutdown and terminal transitions safe

**Files:** Modify `src/opencode-plugin.js`, `src/opencode-activity.js`; test `test/opencode-plugin.test.js`, `test/opencode-activity.test.js`.

**Interfaces:** Preserve `createOpenCodeHooks({ backend, activity?, warn? }) -> { event({ event }), dispose() }` and `OpenCodeActivityTracker.handle(event) -> boolean`. Both adapters will use these unchanged signatures.

- [x] Add a regression proving repeated disposal closes a recording backend exactly once and later events cannot reacquire it. A compact test can use this backend inline:

```js
const backend = {
  calls: [],
  closes: 0,
  setRequired(value) { this.calls.push(value); },
  status() { return { error: null }; },
  close() { this.closes += 1; },
};
const hooks = createOpenCodeHooks({ backend });
hooks.dispose();
hooks.dispose();
hooks.event({ event: {
  type: "session.status",
  properties: { sessionID: "ses_root", status: { type: "busy" } },
} });
assert.equal(backend.closes, 1);
assert.deepEqual(backend.calls, []);
```

- [x] Add tracker regressions: busy -> permission or question wait -> terminal idle/error -> new busy must reacquire; a terminated child's stale wait must stop suppressing its parent; an independent busy sibling must stay protected.
- [x] Run `node --test test/opencode-plugin.test.js test/opencode-activity.test.js` and confirm the new regressions fail for the intended reasons.
- [x] Add a `disposed` guard in `event()` and `dispose()`, setting it before closing the backend. Clear a session's pending waits when processing terminal idle/error states, including idle `session.status`, while retaining its parent metadata. Preserve existing active-state and retry-on-backend-error behavior.

```js
// In createOpenCodeHooks, alongside lastRequired/lastError:
let disposed = false;
// First statement in event():
if (disposed) return;
// First statements in dispose():
if (disposed) return;
disposed = true;
```

- [x] Rerun the focused command. Acceptance: all existing V1 policy tests pass and the new tests establish terminal wait cleanup and one-way disposal.

## Task 2: Translate V2 events without duplicating policy

**Files:** Create `src/opencode-v2-events.js`, `test/opencode-v2-events.test.js`; modify the `test` script in `package.json`.

**Interfaces:** Produce `normalizeOpenCodeV2Event(event: unknown) -> { type: string, properties: object } | null`. Its output is consumed by the existing `hooks.event({ event })` method from Task 1.

- [x] Write table-driven mapping tests for every row of the mapping table, including all three execution outcomes and both form terminal events. Include an exact-output assertion that demonstrates unnecessary fields are dropped:

```js
const input = {
  type: "form.created",
  data: { form: {
    id: "frm_1", sessionID: "ses_root", title: "Private title",
    fields: [{ key: "private", type: "string" }],
  } },
};
assert.deepEqual(normalizeOpenCodeV2Event(input), {
  type: "question.asked",
  properties: { id: "frm_1", sessionID: "ses_root" },
});
assert.equal(normalizeOpenCodeV2Event({
  type: "form.created",
  data: { form: { id: "frm_global", sessionID: "global" } },
}), null);
```

- [x] Test `null`, missing/non-object `data`, absent/empty IDs, missing form payload, unknown status, and unrelated events. Assert that a `properties`-only V1 input is not silently accepted as V2. Feed representative translated sequences into `OpenCodeActivityTracker` and assert the same busy/wait/resume/idle and ancestor/sibling results as V1. Include two simultaneous permission requests plus one form: answering just one request must not resume protection while either of the other waits remains.
- [x] Run `node --test test/opencode-v2-events.test.js`; confirm the new module/behavior is missing before implementation.
- [x] Implement the mapping table with explicit branches and small identifier checks. Example branch shape:

```js
case "form.replied":
case "form.cancelled":
  if (!validSessionID(data.sessionID) || !validID(data.id)) return null;
  return {
    type: event.type === "form.replied" ? "question.replied" : "question.rejected",
    properties: { sessionID: data.sessionID, requestID: data.id },
  };
```

`validID` checks a nonempty string. `validSessionID` also excludes the documented `global` sentinel; do not invent a broader session-ID format constraint than the pinned API requires.

- [x] Append `test/opencode-v2-events.test.js` to the existing explicit `npm test` file list. Run `node --test test/opencode-v2-events.test.js test/opencode-activity.test.js`.

Acceptance: V2 events can drive the existing policy with no V2 branches in the shared tracker and no copying of user content.

## Task 3: Own V2 observation and route it to the right instance

**Files:** Create `src/opencode-v2-plugin.js`, `test/opencode-v2-plugin.test.js`, `test/helpers/opencode.js`; modify the `test` script in `package.json`.

**Interfaces:** Consume Task 1's hooks and Task 2's normalizer. Produce `setupOpenCodeV2(ctx, { backend, activity?, warn? }) -> cleanup`, where `cleanup()` releases inhibition immediately and is safe to call repeatedly. The context supplies `location`, `event.subscribe({ signal })`, and read-only `session.get({ sessionID }, { signal })`.

- [x] Build a small recording backend and a controlled async iterable in the test helper. The iterable must support `push(event)`, `end()`, `fail(error)`, and an abort signal that settles a pending `next()`. Expose a consumed-event acknowledgement so tests wait for processing rather than arbitrary delays. Use this helper only in tests; do not add a runtime queue abstraction.
- [x] Write a test exercising the real shared hooks through `setupOpenCodeV2` with a recording backend: busy -> permission wait -> reply -> form wait -> cancellation -> completion produces `[true, false, true, false, true, false]`.
- [x] Add location tests: matching location, a foreign project location, same project/different directory, optional workspace ID, form owner `global`, and events without an envelope location. For a resumed child, make `ctx.session.get` return `{ id, parentID, location }` and prove that its wait suppresses the busy parent while a busy sibling retains protection. Cache only these metadata fields, and verify repeated ordinary events do not repeatedly fetch the same session. An unknown deleted/terminal session or unmatched wait reply must not trigger a lookup or stop observation of active siblings.
- [x] Add stream tests: synchronous subscribe failure, async iteration rejection, unexpected EOF while busy, cleanup during a pending `next()`, late buffered events after cleanup, and two independent plugin instances. Inspect warning strings with a fake secret in the thrown error and assert the secret is absent. Abort during metadata lookup must not apply the late lookup result.
- [x] Add a focused test for `session.moved`: refresh a previously tracked session's metadata, and if it now belongs to another location, remove its local requirement and cached descendants while preserving other local active sessions. The normalizer returns `null` for this event; the subscriber handles it before normalization as a routing control event. Only cache sessions accepted for this instance, not all foreign session records.
- [x] Run `node --test test/opencode-v2-plugin.test.js` and verify the new adapter tests fail before implementing it.
- [x] Implement one async consumer and one `AbortController`. Process relevant events in order. Resolve unknown session metadata only for supported activity/wait-start events; reuse a complete creation payload instead of immediately querying it. Use `AbortSignal.any([controller.signal, AbortSignal.timeout(1000)])` as one shared deadline for all metadata/ancestor reads required by a single event. Recheck disposal after every await. If a lookup reports that a session has already been removed, drop that session's event and any existing local requirement. Other lookup failures terminate this instance's observation and release its lease, rather than silently losing ancestry or routing data. Distinguish the pinned client's structured not-found error without logging its raw contents, and test this race separately from a network failure.

```js
// Core cancellation boundary inside setupOpenCodeV2:
const controller = new AbortController();
const hooks = createOpenCodeHooks({ backend, activity, warn });
let disposed = false;
function cleanup() {
  if (disposed) return;
  disposed = true;
  controller.abort();
  hooks.dispose();
}
```

The consumer's complete `try/catch/finally` must encompass subscription creation, iteration, normalization, routing, and metadata reads. In `catch`, emit `[Codex Keep Awake] OpenCode V2 observation stopped; reload the plugin to resume protection.` only when cleanup did not request cancellation. On unexpected EOF, emit the same advisory. In `finally`, call `cleanup()`. Attach rejection handling to every background promise; do not let cleanup wait indefinitely for a broken iterator. Use an inner metadata cache keyed by session ID, evict on deletion/location departure, clear it on cleanup, and retain no raw session objects.

- [x] Initialize known sessions in the tracker with a private `session.updated` carrying `{ info: { id, parentID } }` before their first activity/wait event. When metadata names an unknown parent, recover the parent chain with the same bounded reads and cycle detection. Match paths using the platform's `path.resolve`, without lowercasing POSIX paths. Check `event.location`, creation `data.location`, and cached/queried session location consistently; conflicting location evidence must not be accepted.
- [x] Append the new adapter test to `npm test`; run `node --test test/opencode-v2-plugin.test.js test/opencode-v2-events.test.js test/opencode-plugin.test.js test/opencode-activity.test.js`.

Acceptance: no cross-location inhibition, no orphaned lease on any observation exit, no unhandled rejection, no automatic reuse of stale state after lost events, and no interference between plugin instances.

## Task 4: Expose both entrypoints and exercise real GNOME leases

**Files:** Modify `.opencode/plugins/codex-keep-awake.js`, `test/opencode-loader.test.js`, `test/opencode-gnome-integration.test.js`, `test/package.test.js`.

**Interfaces:** V1 continues to call `server()` and receive `{ event, dispose }`. V2 calls `setup(ctx)` and receives a cleanup function. Importing the module must not create a backend or subscribe to anything.

- [x] Extend the loader test to require `id`, `server`, and `setup`. Exercise each entrypoint independently and verify it exposes its host's expected cleanup mechanism. Add a subprocess import check in a temporary directory without `.opencode/node_modules` to ensure the entrypoint has no API-package import requirement.
- [x] Run `node --test test/opencode-loader.test.js` and confirm the missing V2 entrypoint is the failure.
- [x] Add only the V2 adapter import and `setup` property; preserve the current V1 body:

```js
import { setupOpenCodeV2 } from "../../src/opencode-v2-plugin.js";

// Add to the existing default export, beside id and server():
setup(ctx) {
  const backend = createOpenCodeBackend();
  if (!backend) return () => {};
  return setupOpenCodeV2(ctx, { backend });
},
```

No host-version detection, dynamic package selection, duplicated tracker, or second plugin file is necessary. On an unsupported OS, neither entrypoint should start observation or a lease.

- [x] Parameterize `test/opencode-gnome-integration.test.js` into sequential V1 and V2 subtests. V1 injects hook events; V2 uses the controlled iterable and the real `setup()` entrypoint. For both, verify the OpenCode-specific inhibitor count through active work, permission wait, resumed work, form/question wait, answer, completion, and cleanup while still busy. Confirm cleanup leaves no OpenCode inhibitor. Keep assertions scoped to the existing OpenCode reason so Codex inhibitors are untouched.
- [x] Extend the package-content test's required source list with `src/opencode-v2-events.js` and `src/opencode-v2-plugin.js`, and confirm the new plan is excluded by the existing npm allowlist. Do not change the distributed plugin metadata or root runtime dependency policy.
- [x] Run `node --test test/opencode-loader.test.js`, then `npm run validate:package`. On a GNOME desktop with no pre-existing OpenCode Keep Awake lease, run `npm run test:opencode-gnome` and record which of V1 and V2 passed.

Acceptance: the same project-local module supports both hosts without new manual setup; mocked adapter tests and real desktop inhibition are reported as separate evidence.

## Task 5: Verify actual hosts, document the support boundary, and run final checks

**Files:** Modify `AGENTS.md`. The existing `.github/workflows/ci.yml` already runs `npm test` on both required Node versions; the new test-file entries make these checks automatic without another CI job. Keep an execution evidence section at the end of this plan.

**Interfaces:** Consume the completed dual entrypoint and deterministic tests. Produce an accurate compatibility statement and validation record.

- [x] Obtain released OpenCode `1.18.35` and `2.0.29` binaries in separate temporary directories. Use explicit binary paths, never the global `opencode` command. Check each `--version` before running it. Give each process separate temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`; inspect pinned CLI help for configuration and private-server flags. V2 must use its private/standalone server, so validation cannot attach to the user's shared service. Do not migrate the user's configuration or copy credentials into fixtures.
- [x] For each host, prepare a temporary project containing the real `.opencode/plugins/codex-keep-awake.js` and the `src/` files it imports. Confirm automatic plugin discovery and successful initialization from that project. Capture only the selected version, plugin ID/source/status, and sanitized pass/fail results. A Node import test does not count as a host-loader check.
- [x] Drive an actual session on each host through busy, permission wait, response, user-input wait, response, retry, terminal success/failure/interruption, and disposal/reload. Use a local controlled provider/test server with synthetic content to avoid external model costs and personal data. Verify the actual emitted event names, envelopes, form owner, and ancestry against the unit fixtures; correct fixtures and adapter behavior if the host disagrees with the source-derived assumptions. Check Windows execution requests on Windows separately when a Windows host is available; otherwise record that missing prerequisite. Linux passing does not establish Windows runtime validation.
- [x] Record the reload behavior honestly: after observation failure the lease is released and a reload is required; an already-running execution can reacquire at its next observed step, but full immediate activity reconstruction is not implemented. If an actual-host check cannot be run, list its exact missing prerequisite and leave that host's runtime validation explicitly incomplete.
- [x] Update `AGENTS.md`'s existing OpenCode section, rather than adding OpenCode development instructions to `README.md`. Describe both entrypoints, tested version baselines, unchanged platform requirements, location scoping, V2 stream-failure advisory/reload behavior, and the startup/reload limitations. Retain the same normal command examples and distinguish event-injection desktop checks from actual-host checks.
- [x] Run the repository's required checks from the root:

```sh
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run validate:package
```

Run installation before the checks, not between successful checks without a reason. Confirm the root install alone is sufficient; do not add `npm ci --prefix .opencode` as a prerequisite for the unit suite. Run `npm run test:opencode-gnome` when its desktop prerequisites are satisfied. Verify the ordinary suite under Node `24.17.0` and the latest Node 24, either locally with temporary binaries or through the existing CI matrix.

- [x] Review `jj status` and the scoped `jj diff`; confirm only planned implementation/test/documentation files changed. Report actual checks, remaining platform/host gaps, and any departure from the original code-size estimate. Do not publish, push, create a bookmark, or rewrite unrelated changes.

## Review checkpoints and completion criteria

Each task ends with its focused checks and a review of that task's diff. Jujutsu records working-copy changes automatically; do not use Git staging/commit commands or split the user's working copy without authorization.

- [x] V1 behavior remains covered through its actual `server()` entrypoint.
- [x] V2 behavior is covered through `setup(ctx)`, not only the pure normalizer.
- [x] Waits and ancestry behave identically for both versions, including multiple overlapping waits and independently active siblings.
- [x] The V2 subscriber is location-scoped, cancellation-aware, and releases inhibition on failure or EOF.
- [x] Terminal transitions clear waits, and disposed hooks cannot reacquire protection.
- [x] Importing the plugin needs no V2 package and has no runtime side effects.
- [x] Both pinned hosts load the real module; any unavailable end-to-end or platform check is explicitly recorded as incomplete.
- [x] Required root checks pass and documentation claims match the evidence.

## Execution evidence

Implemented and checked on 2026-10-15 in the original Jujutsu working copy. No bookmarks, global OpenCode installation, user configuration, or publishing state were changed.

| Check | Result |
| --- | --- |
| Root `npm ci --ignore-scripts --omit=optional --no-audit --no-fund` | Passed; no `.opencode` dependency install needed for tests. |
| Full `npm test`, Node `24.17.0` | 82 passed, 1 Windows-only parser test skipped, 0 failures. |
| Full `npm test`, Node `24.21.0` | 82 passed, 1 Windows-only parser test skipped, 0 failures. |
| Full `npm test`, Node `24.22.0` (latest Node 24 at verification) | 82 passed, 1 Windows-only parser test skipped, 0 failures. |
| `npm run validate:package` | 3 passed; both V2 modules are in the archive, no runtime npm dependencies added. |
| `npm run test:opencode-gnome` | 2 passed, one per adapter; real GNOME suspend inhibition followed injected lifecycle events. |
| OpenCode `1.18.35`, actual Linux host | Automatic discovery and 20 live inhibition checks passed with an isolated synthetic provider. |
| OpenCode `2.0.29`, actual Linux host | Plugin inventory reported `codex-keep-awake` active; 21 live inhibition checks passed with an isolated synthetic provider. |

The actual-host probes used the released V1 Linux binary and V2's `@opencode/cli-linux-x64@2.0.29` binary, each invoked by its explicit temporary path. Each ran in a disposable project with the real plugin/source files, separate HOME/XDG directories, a private server, and an HTTP provider that generated only synthetic tool calls and completions. No paid provider or personal credentials were used. Each probe checked work, permission waits/replies, question waits/replies, retries, terminal failure, interruption, configuration reload, waiting children, independent active siblings, resumed family protection, and final lease release. V1 emitted its existing hook events; V2 emitted native execution, permission, retry, and form events.

Two source/runtime findings refined the implementation and checks:

1. V2's [in-process Promise adapter](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/adapter.ts) ignores the HTTP client's request-options argument for session reads. `readSession` therefore owns an abort/deadline race, rather than relying on passing a signal alone. A regression first failed with a stalled host read, then passed with lease release at the one-second deadline. Late read completion cannot reacquire the lease after cleanup.
2. V2's [location cache](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/location-service-map.ts) can retain the old generation while a request remains in flight through reload. The live probe verified continued protection across reload, then interruption, disappearance of the old lease PIDs, and release of GNOME inhibition. A forced zero-inhibitor assertion immediately after reload would incorrectly reject continued active work. Direct cleanup while busy is separately covered by unit and GNOME adapter tests.

The new V2 source consists of 174 lines across the mapper and subscriber, plus six entrypoint lines and narrow shared lifecycle safeguards. The two new test suites and their async-stream/recording-backend helper total 342 lines, with additional extensions to existing tests. Test scaffolding exceeded the initial 150–300-line estimate because location routing, cancellation that the host ignores, and shutdown ownership required explicit coverage; runtime code stayed within the estimated size.

Remaining validation limits: no Windows host was available for live `powercfg /requests` or PowerShell parser execution. Existing Windows backend tests pass with controlled processes, but live Windows inhibition remains unverified. macOS remains unsupported. Node reports the existing module-type warning for `.opencode/package.json`; its dependency metadata was left intact as planned. Event-only startup/reload and silent-stream limitations are documented in `AGENTS.md`.

The synthetic host fixtures and their generated logs/session state were removed after extracting these sanitized results. Temporary public binaries/source downloads are not part of the repository change. The original root `PLAN.md` and `README.md` remain unchanged.
