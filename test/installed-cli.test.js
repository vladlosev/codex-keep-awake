import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "codex-keep-awake.js");
const pluginId = "codex-keep-awake@codex-keep-awake";

function fixture(t, { installed = true, listExitCode = 0, listOutput } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "keep-awake installed cli "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex home");
  const pluginRoot = path.join(codexHome, "plugins", "cache", "codex-keep-awake", "codex-keep-awake", "2.0.0");
  const dataDirectory = path.join(codexHome, "plugins", "data", "codex-keep-awake-codex-keep-awake");
  const marker = path.join(root, "installed-invocation.json");
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "unrelated directory");
  mkdirSync(bin);
  mkdirSync(cwd);
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  cpSync(path.join(repoRoot, "src"), path.join(pluginRoot, "src"), { recursive: true });
  writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"module"}\n');
  const installedScript = path.join(pluginRoot, "scripts", "codex-keep-awake.js");
  writeFileSync(installedScript, `
    import { writeFileSync } from "node:fs";
    import { main } from "../src/cli.js";
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
    await main();
  `);
  const payload = { installed: installed ? [{
    pluginId,
    name: "codex-keep-awake",
    marketplaceName: "codex-keep-awake",
    version: "2.0.0",
  }] : [], available: [] };
  const codex = path.join(bin, "codex");
  writeFileSync(codex, `#!/usr/bin/env node
    const expected = ["plugin", "list", "--marketplace", "codex-keep-awake", "--json"];
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);
    process.stdout.write(${JSON.stringify(listOutput ?? JSON.stringify(payload))});
    process.exit(${listExitCode});
  `);
  chmodSync(codex, 0o755);
  const state = {
    version: 1,
    updatedAt: 0,
    supervisor: null,
    runtime: null,
    threads: { registered: {
      threadId: "registered",
      currentTurnId: "turn-1",
      active: true,
      waiting: null,
      subagents: {},
    } },
  };
  const stateFile = path.join(dataDirectory, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
  };
  delete env.PLUGIN_DATA;
  delete env.PLUGIN_ROOT;
  return {
    root, marker, dataDirectory, stateFile, installedScript,
    run(args, extraEnv = {}) {
      const isolateHome = `import os from "node:os"; os.homedir = () => ${JSON.stringify(path.join(root, "fallback home"))};`;
      return spawnSync(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(isolateHome)}`,
        cliPath, ...args,
      ], {
        cwd,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
  };
}

test("status from an unrelated directory uses the active installed plugin and its data", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const result = f.run(["status"]);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.dataDirectory, f.dataDirectory);
  assert.equal(status.registeredThreads, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.marker, "utf8")), ["status", "--data-dir", f.dataDirectory]);
});

test("cleanup resets only the installed plugin's state", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const otherState = path.join(f.root, "other-state.json");
  writeFileSync(otherState, "unrelated state");
  const result = f.run(["cleanup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cleaned, true);
  const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
  assert.deepEqual(state.threads, {});
  assert.equal(state.runtime, null);
  assert.equal(state.supervisor, null);
  assert.equal(readFileSync(otherState, "utf8"), "unrelated state");
  assert.deepEqual(JSON.parse(readFileSync(f.marker, "utf8")), ["cleanup", "--data-dir", f.dataDirectory]);
});

for (const [description, options, message] of [
  ["not installed", { installed: false }, /not installed/i],
  ["Codex discovery fails", { listExitCode: 7 }, /could not list installed Codex plugins/i],
  ["Codex returns invalid JSON", { listOutput: "invalid JSON" }, /invalid plugin list/i],
]) {
  test(`cleanup fails without changing state when ${description}`, { skip: process.platform === "win32" }, (t) => {
    const f = fixture(t, options);
    const before = readFileSync(f.stateFile, "utf8");
    const result = f.run(["cleanup"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(readFileSync(f.stateFile, "utf8"), before);
    assert.equal(existsSync(f.marker), false);
  });
}

test("a missing installed script produces an actionable error", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  rmSync(f.installedScript);
  const result = f.run(["status"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed plugin script is missing.*reinstall/i);
});

test("the installed command's failure exit code is preserved", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  writeFileSync(f.installedScript, "process.exit(23);\n");
  assert.equal(f.run(["status"]).status, 23);
});

test("explicit data directories bypass installed-plugin discovery", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t, { listExitCode: 7 });
  for (const [args, env] of [
    [["status", "--data-dir", f.dataDirectory], {}],
    [["status", `--data-dir=${f.dataDirectory}`], {}],
    [["status"], { PLUGIN_DATA: f.dataDirectory }],
  ]) {
    const result = f.run(args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dataDirectory, f.dataDirectory);
  }
  assert.equal(existsSync(f.marker), false);
});
