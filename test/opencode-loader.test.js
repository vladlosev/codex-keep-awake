import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { controlledEvents } from "./helpers/opencode.js";
import OpenCodeKeepAwake from "../.opencode/plugins/codex-keep-awake.js";

test("project-local OpenCode module exposes the V1 server lifecycle", async () => {
  assert.equal(OpenCodeKeepAwake.id, "codex-keep-awake");
  assert.equal(typeof OpenCodeKeepAwake.server, "function");

  const hooks = await OpenCodeKeepAwake.server({});
  assert.equal(typeof hooks.event, "function");
  assert.equal(typeof hooks.dispose, "function");
  hooks.dispose();
});

test("the same project-local module exposes V2 setup and cancels its subscription", {
  skip: !["linux", "win32"].includes(process.platform),
}, async () => {
  assert.equal(typeof OpenCodeKeepAwake.setup, "function");
  const stream = controlledEvents();
  const cleanup = await OpenCodeKeepAwake.setup({
    location: { directory: "/project" },
    event: { subscribe: (options) => stream.subscribe(options) },
  });
  assert.equal(typeof cleanup, "function");
  cleanup();
  cleanup();
  await stream.closed;
});

test("a clean copy imports both entrypoints without API packages or startup side effects", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "keep-awake-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  cpSync(path.join(root, "src"), path.join(directory, "src"), { recursive: true });
  mkdirSync(path.join(directory, ".opencode/plugins"), { recursive: true });
  cpSync(path.join(root, ".opencode/plugins/codex-keep-awake.js"), path.join(directory, ".opencode/plugins/plugin.js"));
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const { default: p } = await import("./.opencode/plugins/plugin.js"); console.log(typeof p.server, typeof p.setup);',
  ], { cwd: directory, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "function function");
});
