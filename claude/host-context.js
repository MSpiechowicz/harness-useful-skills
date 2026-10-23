import { constants, lstatSync, readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { migrateDirectory } from "../data-migration.js";
import { resolveHostRoots } from "../host-roots.js";
import { LEGACY_CLAUDE_PLUGIN_ID, LEGACY_DATA_DIRECTORY } from "../legacy-names.js";
import { DATA_DIRECTORY, PLUGIN_ID } from "../names.js";
import { claudeConfigDir } from "./models.js";

const CLAUDE_FACTS = Object.freeze({ label: "Claude", backend: "claude-local-facts", directory: "claude-facts" });

/** Claude Code names a plugin's data directory after `<plugin>@<marketplace>` with unsafe characters replaced. */
export function pluginDataName(pluginId) {
  return String(pluginId).replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Claude keys a plugin's data directory by its id, so the renamed plugin starts with an empty one. Carry the memory
 * saved by the plugin under its earlier id over, from the sibling directory the earlier plugin used.
 */
function migrateLegacyPluginData(data) {
  if (typeof data !== "string" || path.basename(data) !== pluginDataName(PLUGIN_ID)) {
    return;
  }

  const legacyData = path.join(path.dirname(data), pluginDataName(LEGACY_CLAUDE_PLUGIN_ID));
  migrateDirectory(path.join(legacyData, LEGACY_DATA_DIRECTORY), path.join(data, DATA_DIRECTORY));
}

/**
 * What the plugin under its earlier id left behind: the plugin itself when it is still installed (it declares the
 * same hooks and agents, so both would run), and files in its data directory that migration kept because they differ.
 */
export function claudeLegacyNotes(environment = process.env) {
  const configDir = claudeConfigDir(environment);
  const notes = [];

  let installed;
  try {
    installed = JSON.parse(readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    installed = undefined;
  }

  if (isRecord(installed?.plugins) && Object.hasOwn(installed.plugins, LEGACY_CLAUDE_PLUGIN_ID)) {
    notes.push(`The earlier plugin ${LEGACY_CLAUDE_PLUGIN_ID} is still installed. Remove it with \`claude plugin uninstall ${LEGACY_CLAUDE_PLUGIN_ID}\`, then \`/reload-plugins\`.`);
  }

  const legacyData = path.join(configDir, LEGACY_DATA_DIRECTORY);
  if (lstatSync(legacyData, { throwIfNoEntry: false })) {
    notes.push(`${legacyData} still holds files that were not moved to ${path.join(configDir, DATA_DIRECTORY)} because they differ from the ones there. Review them, then delete the old folder.`);
  }

  return notes;
}

/** Resolve the Claude project and plugin data roots used by memory tools and doctor setup. */
export async function resolveHostContext({ workspace, data } = {}) {
  migrateLegacyPluginData(data);
  return resolveHostRoots({ workspace, data, label: "Claude", facts: CLAUDE_FACTS });
}

const PLUGIN_STATE_MAX_BYTES = 1024 * 1024;
const NOT_INSTALLED = "This plugin is not running from the Claude Code plugin cache or an installed directory marketplace.";

/**
 * Read a small JSON file that must be a regular file, never following a symbolic link or blocking on
 * a FIFO before the regular-file check. Missing files read as undefined.
 */
async function readPluginState(file, label) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }

    throw new Error(error?.code === "ELOOP" ? `${label} must not be a symbolic link.` : `Cannot read ${label}.`);
  }

  let text;
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new Error(`${label} must be a regular file.`);
    }

    if (details.size > PLUGIN_STATE_MAX_BYTES) {
      throw new Error(`${label} is too large.`);
    }

    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The manifest name, read like other plugin state: only a bounded regular file, never through a
 * symbolic link or by blocking on a FIFO. Installed packages ship `.claude-plugin/plugin.json` as a regular file.
 */
async function pluginName(root) {
  const manifest = await readPluginState(path.join(root, ".claude-plugin", "plugin.json"), "Plugin manifest");
  if (manifest === undefined) {
    throw new Error("Cannot read the installed plugin manifest.");
  }

  if (typeof manifest?.name !== "string" || !manifest.name) {
    throw new Error("The installed plugin manifest has no name.");
  }

  return manifest.name;
}

/** Claude installs marketplace copies at <cache>/<marketplace>/<name>/<version>; returns undefined outside that layout. */
async function cacheInstall(configDir, root) {
  let cache;
  try {
    cache = await realpath(path.join(configDir, "plugins", "cache"));
  } catch {
    return undefined;
  }

  const relative = path.relative(cache, root);
  const segments = relative.split(path.sep);
  const valid = !path.isAbsolute(relative)
    && segments.length === 3
    && segments.every(segment => segment && segment !== "." && segment !== "..");
  if (!valid) {
    return undefined;
  }

  const [marketplace, name] = segments;
  const manifestName = await pluginName(root);
  if (manifestName !== name) {
    throw new Error("The plugin cache directory does not match the plugin manifest name.");
  }

  return { marketplace, name };
}

/** Whether a directory marketplace's catalog lists plugin `name` with a source that resolves to `root`. */
async function marketplaceServes(entry, name, root) {
  const location = typeof entry.installLocation === "string" ? entry.installLocation : entry.source.path;
  if (typeof location !== "string" || !path.isAbsolute(location)) {
    return false;
  }

  let catalog;
  let marketplaceRoot;
  try {
    marketplaceRoot = await realpath(location);
    catalog = await readPluginState(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "Marketplace catalog");
  } catch {
    // An unrelated stale or broken marketplace must not block this plugin.
    return false;
  }

  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  for (const plugin of plugins) {
    if (plugin?.name !== name || typeof plugin.source !== "string") {
      continue;
    }

    const source = await realpath(path.resolve(marketplaceRoot, plugin.source)).catch(() => undefined);
    if (source === root) {
      return true;
    }
  }

  return false;
}

/** A directory marketplace runs the plugin in place, so match it through Claude's marketplace and install records. */
async function directoryMarketplaceInstall(configDir, root) {
  // Outside the cache, a folder without a plugin manifest is simply not an installed plugin.
  const name = await pluginName(root).catch(() => {
    throw new Error(NOT_INSTALLED);
  });

  const pluginsDir = path.join(configDir, "plugins");
  const known = await readPluginState(path.join(pluginsDir, "known_marketplaces.json"), "Claude known marketplaces list");
  const installed = await readPluginState(path.join(pluginsDir, "installed_plugins.json"), "Claude installed plugins list");
  if ((known !== undefined && !isRecord(known)) || (installed !== undefined && !isRecord(installed))) {
    throw new Error("Claude plugin install records have an unexpected format.");
  }

  const installs = isRecord(installed?.plugins) ? installed.plugins : {};
  const matches = [];
  for (const [marketplace, entry] of Object.entries(known ?? {})) {
    if (!isRecord(entry) || !isRecord(entry.source) || entry.source.source !== "directory") {
      continue;
    }

    const id = `${name}@${marketplace}`;
    const records = Object.hasOwn(installs, id) ? installs[id] : undefined;
    if (!Array.isArray(records) || records.length === 0) {
      continue;
    }

    if (await marketplaceServes(entry, name, root)) {
      matches.push(marketplace);
    }
  }

  if (matches.length > 1) {
    throw new Error("Ambiguous plugin install: more than one directory marketplace serves this plugin.");
  }

  if (matches.length === 0) {
    throw new Error(NOT_INSTALLED);
  }

  return { marketplace: matches[0], name };
}

/**
 * Locate the persistent data directory Claude Code assigns to this installed plugin, without
 * creating it. Returns `{ dataDir }`, or `{ reason }` when the install layout cannot be trusted.
 */
export async function claudePluginDataDir({ environment = process.env, packageRoot } = {}) {
  try {
    const configDir = await realpath(claudeConfigDir(environment)).catch(() => {
      throw new Error("Claude config directory cannot be resolved.");
    });
    const root = await realpath(packageRoot).catch(() => {
      throw new Error("Claude plugin package root cannot be resolved.");
    });

    const { marketplace, name } = await cacheInstall(configDir, root) ?? await directoryMarketplaceInstall(configDir, root);
    const dataDir = path.join(configDir, "plugins", "data", pluginDataName(`${name}@${marketplace}`));

    let details;
    try {
      details = await lstat(dataDir);
    } catch {
      throw new Error("Claude plugin data directory does not exist yet; start a Claude Code session with the plugin enabled first.");
    }

    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error("Claude plugin data directory must be a real directory, not a symbolic link.");
    }

    return { dataDir };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}
