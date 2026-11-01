import { readFileSync } from "node:fs";
import path from "node:path";

import { ROLE_AGENTS, ROLES } from "./model-roles.js";

/** Role -> plugin agent, for the roles that have one. */
const AGENT_OF_ROLE = Object.fromEntries(Object.entries(ROLE_AGENTS).map(([agent, role]) => [role, agent]));

/** The keys under `modelRoles:` in OMP config text, by a minimal line scan; undefined when there is no such block. */
export function modelRoleKeys(text) {
  const keys = [];
  let inBlock = false;
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim() || row.trimStart().startsWith("#")) continue;
    if (/^modelRoles:\s*(#.*)?$/.test(row)) {
      inBlock = true;
      continue;
    }
    if (!/^\s/.test(row)) {
      inBlock = false;
      continue;
    }
    const key = inBlock ? /^\s+["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(row) : undefined;
    if (key) keys.push(key[1]);
  }
  return inBlock || keys.length ? keys : undefined;
}

/**
 * Useful Skills roles that the active OMP profile's `config.yml` does not map under `modelRoles:`. Read-only.
 * A profile without a `modelRoles:` block, or without a readable config, uses no roles, so nothing is reported.
 * Returns `[{ role, agent }]`.
 */
export function unmappedOmpRoles(agentDir) {
  let keys;
  try {
    keys = modelRoleKeys(readFileSync(path.join(agentDir, "config.yml"), "utf8"));
  } catch {
    return [];
  }

  if (!keys?.length) return [];
  return ROLES.filter(role => role !== "default" && AGENT_OF_ROLE[role] && !keys.includes(role)).map(role => ({ role, agent: AGENT_OF_ROLE[role] }));
}
