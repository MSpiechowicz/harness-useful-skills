import os from "node:os";
import path from "node:path";

import { errorMessage } from "../command-core.js";
import { resolveHostRoots } from "../host-roots.js";

const CODEX_FACTS = Object.freeze({ label: "Codex", backend: "codex-local-facts", directory: "codex-facts" });
const UNRESOLVED = "Codex project root or Useful Skills data directory cannot be resolved; run `./useful-skills install --host codex` (or the install script with HARNESS_SKILLS_HOST=codex) again.";

/** The user's home: an absolute HOME from the environment, else the operating system's answer. */
function homeDirectory(environment) {
  return environment.HOME && path.isAbsolute(environment.HOME) ? environment.HOME : os.homedir();
}

/**
 * The Useful Skills data directory for Codex: an absolute USEFUL_SKILLS_DATA (set by `codex mcp add --env`),
 * else `$HOME/.codex/useful-skills/data`. Codex does not pass CODEX_HOME to MCP servers, so it is not consulted.
 * Returns the path, or `{ reason }` for a relative override.
 */
export function resolveCodexDataDir(environment = process.env) {
  const override = environment.USEFUL_SKILLS_DATA;
  if (override !== undefined && override !== "") {
    return path.isAbsolute(override) ? override : { reason: "USEFUL_SKILLS_DATA must be an absolute path." };
  }

  return path.join(homeDirectory(environment), ".codex", "useful-skills", "data");
}

/** Resolve the Codex project and private data roots to `{ cwd, agentDir, memory }`, or throw. */
export async function resolveCodexHostContext({ workspace, environment = process.env } = {}) {
  const data = resolveCodexDataDir(environment);
  if (typeof data !== "string") {
    throw new Error(data.reason);
  }

  return resolveHostRoots({ workspace, data, label: "Codex", facts: CODEX_FACTS });
}

/** Like resolveCodexHostContext, but resolves to `{ host }` or a printable `{ reason }` without raw system paths. */
export async function locateCodexHost(options = {}) {
  try {
    return { host: await resolveCodexHostContext(options) };
  } catch (error) {
    // System errors embed raw paths; keep only the validation messages.
    return { reason: error?.code ? UNRESOLVED : errorMessage(error) };
  }
}
