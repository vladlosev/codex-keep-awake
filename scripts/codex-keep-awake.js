#!/usr/bin/env node
import { main } from "../src/cli.js";

main().catch((error) => {
  if (process.argv[2] === "hook") {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Codex Keep Awake: ${error.message}` })}\n`);
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`codex-keep-awake: ${error.message}\n`);
  process.exitCode = 1;
});
