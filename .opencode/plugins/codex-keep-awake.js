import { createOpenCodeBackend } from "../../src/opencode-backend.js";
import { createOpenCodeHooks } from "../../src/opencode-plugin.js";

export default {
  id: "codex-keep-awake",
  async server() {
    const backend = createOpenCodeBackend();
    if (!backend) return { event() {}, dispose() {} };
    return createOpenCodeHooks({ backend });
  },
};
