import { resolveHostRoots } from "../host-roots.js";
import { errorMessage } from "../command-core.js";
import { resolveDataDir, RUNTIME_ROOT } from "./paths.js";

const OPENCODE_FACTS = Object.freeze({ label: "OpenCode", backend: "opencode-local-facts", directory: "opencode-facts" });

/**
 * Resolve the OpenCode project and private data roots used by memory tools and doctor setup.
 * Returns `{ cwd, agentDir, memory }`, or throws when the data directory cannot be located or trusted.
 */
export async function resolveOpenCodeHostContext({ workspace, environment = process.env, runtimeRoot = RUNTIME_ROOT } = {}) {
  const data = resolveDataDir({ environment, runtimeRoot });
  if (typeof data !== "string") {
    throw new Error(data.reason);
  }

  return resolveHostRoots({ workspace, data, label: "OpenCode", facts: OPENCODE_FACTS });
}

/** Like resolveOpenCodeHostContext, but resolves to `{ host }` or a printable `{ reason }` without raw system paths. */
export async function locateOpenCodeHost(options = {}) {
  try {
    return { host: await resolveOpenCodeHostContext(options) };
  } catch (error) {
    // System errors embed raw paths; keep only the validation messages.
    return { reason: error?.code ? "OpenCode project root or Useful Skills data directory cannot be resolved; run `./useful-skills install --host opencode`." : errorMessage(error) };
  }
}
