/**
 * The names Harness Skills used before they were unified under one name (see names.js). Only migration and
 * leftover detection may read this module: nothing else should still mention them.
 */

/** The plugin name on every host, and the Claude marketplace and data directory built from it. */
export const LEGACY_PLUGIN_NAME = "useful-skills";
export const LEGACY_CLAUDE_MARKETPLACE = "useful-skills-local";
export const LEGACY_CLAUDE_PLUGIN_ID = `${LEGACY_PLUGIN_NAME}@${LEGACY_CLAUDE_MARKETPLACE}`;

/** The Codex marketplace kept its name; only the plugin inside it was renamed. */
export const LEGACY_CODEX_PLUGIN_ID = `${LEGACY_PLUGIN_NAME}@harness-useful-skills`;

export const LEGACY_MCP_SERVER_NAME = "useful_skills";
export const LEGACY_DATA_DIRECTORY = LEGACY_PLUGIN_NAME;

/** OpenCode installed `plugins/useful-skills.js` plus the runtime tree `plugins/useful-skills/`. */
export const LEGACY_OPENCODE_ENTRY = `${LEGACY_PLUGIN_NAME}.js`;
export const LEGACY_OPENCODE_RUNTIME = LEGACY_PLUGIN_NAME;

/** Claude generated role agents as `agents/useful-skills-<agent>.md`. */
export const legacyClaudeAgentFile = agent => `${LEGACY_PLUGIN_NAME}-${agent}.md`;
