import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeKeepAwake from "../.opencode/plugins/codex-keep-awake.js";

test("project-local OpenCode module exposes the V1 server lifecycle", async () => {
  assert.equal(OpenCodeKeepAwake.id, "codex-keep-awake");
  assert.equal(typeof OpenCodeKeepAwake.server, "function");

  const hooks = await OpenCodeKeepAwake.server({});
  assert.equal(typeof hooks.event, "function");
  assert.equal(typeof hooks.dispose, "function");
  hooks.dispose();
});
