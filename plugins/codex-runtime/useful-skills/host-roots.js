import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { createLocalFacts } from "./local-facts.js";

/**
 * Resolve a host's project and persistent data roots used by memory tools and doctor setup.
 * `label` prefixes error messages; `facts` is the `createLocalFacts` host descriptor
 * (`{ label, backend, directory }`). Returns `{ cwd, agentDir, memory }` or throws.
 */
export async function resolveHostRoots({ workspace, data, label, facts }) {
  if (!workspace || !data || !path.isAbsolute(workspace) || !path.isAbsolute(data)) {
    throw new Error(`${label} project root and persistent plugin data root are required.`);
  }

  const [cwd, resolvedData] = await Promise.all([realpath(workspace), realpath(data)]);
  if (path.resolve(data) !== resolvedData) {
    throw new Error(`${label} plugin data root must not contain symbolic links.`);
  }

  const [workspaceEntry, dataEntry] = await Promise.all([lstat(cwd), lstat(resolvedData)]);
  if (!workspaceEntry.isDirectory() || !dataEntry.isDirectory()) {
    throw new Error(`${label} project and plugin data roots must be directories.`);
  }

  return { cwd, agentDir: resolvedData, memory: createLocalFacts({ cwd, agentDir: resolvedData, host: facts }) };
}
