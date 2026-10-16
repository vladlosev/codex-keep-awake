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
    // V1's internal catalog host also calls setup(), without activity APIs.
    if (typeof ctx?.event?.subscribe !== "function") return () => {};
    const backend = createOpenCodeBackend();
    if (!backend) return () => {};
    return setupOpenCodeV2(ctx, { backend });
  },
};
