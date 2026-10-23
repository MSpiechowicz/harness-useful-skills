/**
 * The one name Harness Skills uses on every host: plugin, marketplace, MCP server, skill and agent namespace, and
 * the data directory below a host's config or data root. Names from before the rename live in legacy-names.js.
 */
export const PRODUCT_NAME = "harness-useful-skills";

export const PLUGIN_NAME = PRODUCT_NAME;
export const MARKETPLACE_NAME = PRODUCT_NAME;
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MCP_SERVER_NAME = PRODUCT_NAME;
export const DATA_DIRECTORY = PRODUCT_NAME;

/** OpenCode prefixes every tool of an MCP server with `<server>_`. */
export const OPENCODE_TOOL_PREFIX = `${MCP_SERVER_NAME}_`;
