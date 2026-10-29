import path from "node:path";

import { startMemoryServer } from "../mcp-memory-server.js";
import { exitOnTermination } from "../process.js";
import { locateOpenCodeHost } from "./host-context.js";

// OpenCode starts local MCP servers in its launch directory; an absolute USEFUL_SKILLS_WORKSPACE overrides it.
function workspace() {
  const configured = process.env.USEFUL_SKILLS_WORKSPACE;
  return configured && path.isAbsolute(configured) ? configured : process.cwd();
}

// A server stopped by a signal must still end any child process it started.
exitOnTermination();
startMemoryServer({
  factsLabel: "OpenCode",
  resolveContext: async () => {
    const { host, reason } = await locateOpenCodeHost({ workspace: workspace(), environment: process.env });
    return host ?? { reason };
  },
});
