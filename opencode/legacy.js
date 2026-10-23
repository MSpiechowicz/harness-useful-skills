/**
 * What an OpenCode install from before the rename (plugin, MCP server and data under the old name) leaves behind,
 * for the installer to clean up and for doctor to report.
 */
import path from "node:path";

import { LEGACY_MCP_SERVER_NAME, LEGACY_OPENCODE_ENTRY, LEGACY_OPENCODE_RUNTIME } from "../legacy-names.js";
import { CONFIG_CANDIDATES, readConfigFile } from "./config-file.js";
import { legacyDataDir, legacyInstallRecordPath, lstatOrNull, readInstallRecord } from "./paths.js";

/** The earlier install's record: `{ record }`, `{ problem }` when it cannot be used, or `{}` when there is none. */
export function readLegacyRecord(scopeRoot) {
  try {
    const record = readInstallRecord(legacyInstallRecordPath(scopeRoot));
    return record ? { record } : {};
  } catch (error) {
    return { problem: error.message };
  }
}

/** Config files in the scope root that still define the earlier MCP server name. */
function configsWithLegacyServer(scopeRoot) {
  return CONFIG_CANDIDATES.map(name => path.join(scopeRoot, name)).filter(file => {
    try {
      return readConfigFile(file)?.includes(LEGACY_MCP_SERVER_NAME) === true;
    } catch {
      return false;
    }
  });
}

/** Doctor lines for each leftover of the earlier install in `scopeRoot` (and the data directory), or none. */
export function legacyLeftovers({ scopeRoot, environment }) {
  const lines = [];
  const entry = path.join(scopeRoot, "plugins", LEGACY_OPENCODE_ENTRY);
  const runtime = path.join(scopeRoot, "plugins", LEGACY_OPENCODE_RUNTIME);

  if (lstatOrNull(entry) || lstatOrNull(runtime)) {
    lines.push(`Earlier install: ${entry} or ${runtime} is still there. Run \`./useful-skills install --host opencode\` from this release to replace it.`);
  }

  for (const file of configsWithLegacyServer(scopeRoot)) {
    lines.push(`Earlier install: ${file} still defines mcp.${LEGACY_MCP_SERVER_NAME}. Run the installer to replace it, or remove it yourself.`);
  }

  const data = legacyDataDir(environment);
  if (lstatOrNull(data)) {
    lines.push(`Earlier install: ${data} still exists. The installer moves it to the new data directory.`);
  }

  return lines;
}
