import { startMemoryServer } from "../mcp-memory-server.js";
import { resolveHostContext } from "./host-context.js";

startMemoryServer({
  factsLabel: "Claude",
  resolveContext: () => resolveHostContext({ workspace: process.env.CLAUDE_PROJECT_DIR, data: process.env.CLAUDE_PLUGIN_DATA }),
});
