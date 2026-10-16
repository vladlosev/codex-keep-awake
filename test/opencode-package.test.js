import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("an installed archive exposes both OpenCode lifecycles without development dependencies", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "keep-awake-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const consumer = path.join(directory, "consumer");
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^npm_config_/i.test(key)));
  Object.assign(env, {
    npm_config_cache: path.join(directory, "npm-cache"),
    npm_config_userconfig: path.join(directory, "user.npmrc"),
    npm_config_globalconfig: path.join(directory, "global.npmrc"),
  });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, {
      cwd, env, encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    return result.stdout;
  };
  const packed = JSON.parse(run(npm, [
    "pack", "--json", "--ignore-scripts", "--pack-destination", directory,
  ], root));
  const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
  run(npm, [
    "install", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund",
    "--package-lock=false", "--offline", path.join(directory, filename),
  ], consumer);
  assert.equal(existsSync(path.join(consumer, "node_modules", "ws")), false);
  writeFileSync(path.join(consumer, "verify.mjs"), `
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
  `);
  run(process.execPath, ["verify.mjs"], consumer);
});
