import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));

test("Codex package, plugin, marketplace, and locked dependency metadata agree", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const plugin = readJson(".codex-plugin/plugin.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");

  assert.equal(pkg.name, "codex-keep-awake");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.hooks, "./hooks/hooks.json");
  assert.equal(marketplace.name, pkg.name);
  assert.deepEqual(marketplace.plugins.map(({ name, source }) => [name, source]), [
    [pkg.name, { source: "local", path: "./" }],
  ]);
  assert.equal(lock.packages["node_modules/ws"].version, "8.22.0");
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.devDependencies.ws, "8.22.0");
  assert.equal(lock.packages["node_modules/ws"].dev, true);
  assert.equal(pkg.engines.node, "^24.17.0");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
});

test("every Codex hook uses the bounded advisory runtime", () => {
  const { hooks } = readJson("hooks/hooks.json");
  const expectedEvents = [
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "Interrupt",
    "SessionEnd",
  ].sort();

  assert.deepEqual(Object.keys(hooks).sort(), expectedEvents);
  for (const eventHooks of Object.values(hooks)) {
    assert.equal(eventHooks.length, 1);
    assert.equal(eventHooks[0].hooks.length, 1);
    const [hook] = eventHooks[0].hooks;
    assert.equal(hook.type, "command");
    assert.equal(hook.command, 'node "${PLUGIN_ROOT}/scripts/codex-keep-awake.js" hook');
    assert.ok(hook.timeout > 0 && hook.timeout <= 3);
  }
});

test("the npm archive contains the Codex runtime and excludes repository-only files", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const packResult = JSON.parse(result.stdout);
  const [{ files }] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  const paths = new Set(files.map(({ path: filePath }) => filePath));

  for (const expected of [
    "README.md",
    "LICENSE",
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "scripts/codex-keep-awake.js",
    "src/app-server-observer.js",
    "src/backend.js",
    "src/cli.js",
    "src/hook-runtime.js",
    "src/installed-plugin.js",
    "src/lease.js",
    "src/lease-backend.js",
    "src/macos-keep-awake.swift",
    "src/opencode-activity.js",
    "src/opencode-backend.js",
    "src/opencode-plugin.js",
    "src/state.js",
    "src/supervisor.js",
    "src/unix-websocket.js",
    "src/windows-backend.js",
    "src/windows-keep-awake.ps1",
  ]) assert.ok(paths.has(expected), `npm archive is missing ${expected}`);

  for (const filePath of paths) {
    assert.ok(!filePath.startsWith("test/"), `npm archive contains ${filePath}`);
    assert.ok(!filePath.startsWith(".agents/"), `npm archive contains ${filePath}`);
    assert.ok(!filePath.startsWith(".claude-plugin/"), `npm archive contains ${filePath}`);
    assert.notEqual(filePath, "PLAN.md");
  }

  const obsoleteRuntime = /claude|anthropic|AskUserQuestion|StopFailure|CLAUDE_|transcript|(?:rate|usage)[ _-]?limit|auto[ _-]?continue/i;
  for (const filePath of paths) {
    if (!/\.(?:js|json|swift|ps1)$/.test(filePath)) continue;
    const content = readFileSync(path.join(root, filePath), "utf8");
    assert.doesNotMatch(content, obsoleteRuntime, `${filePath} contains obsolete lifecycle logic`);
  }
});
