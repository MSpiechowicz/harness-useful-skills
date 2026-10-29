import path from "node:path";

import { startMemoryServer } from "../mcp-memory-server.js";
import { exitOnTermination } from "../process.js";
import { locateCodexHost } from "./host-context.js";

// Codex starts MCP servers in the session's workspace and sends an empty roots list; an absolute USEFUL_SKILLS_WORKSPACE overrides it.
function workspace() {
  const configured = process.env.USEFUL_SKILLS_WORKSPACE;
  return configured && path.isAbsolute(configured) ? configured : process.cwd();
}

// A server stopped by a signal must still end any child process it started.
exitOnTermination();
startMemoryServer({
  factsLabel: "Codex",
  resolveContext: async () => {
    const { host, reason } = await locateCodexHost({ workspace: workspace(), environment: process.env });
    return host ?? { reason };
  },
});
