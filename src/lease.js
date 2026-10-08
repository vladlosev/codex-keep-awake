import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEASE_READY_LINE = "CODEX_KEEP_AWAKE_LEASE_READY";

export async function runLease({ stdin = process.stdin, stdout = process.stdout } = {}) {
  stdout.write(`${LEASE_READY_LINE}\n`);
  for await (const _chunk of stdin) {
    // The owning process holds stdin open for the duration of the lease.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runLease();
}
