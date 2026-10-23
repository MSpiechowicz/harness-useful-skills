import { realpathSync } from "node:fs";
import path from "node:path";

import { ownedState } from "../opencode/install-files.js";
import { directoryProblem, lstatOrNull, printableText } from "../opencode/paths.js";
import { CODEX_MISSING, codexClient, marketplaceRef, sameMcp } from "./codex-cli.js";
import { LEGACY_DATA_DIRECTORY } from "../legacy-names.js";
import { describeSelection, readCodexModels, selectionFor } from "./models.js";
import { AGENT_RELS, INSTALL_COMMAND, LEGACY_LAYOUT, MARKETPLACE_NAME, PLUGIN_ID, RECORD_REL, TIMEOUT_NOTE, atHome, codexHomeFor, mcpEntryFor, readCodexRecord, readLegacyRecord } from "./paths.js";

const reason = (error) => (error instanceof Error ? error.message : String(error));

/** Run one probe; a thrown error becomes `{error}` so a damaged install is reported, never raised. */
function attempt(probe) {
  try {
    return { value: probe() };
  } catch (error) {
    return { error: reason(error) };
  }
}

function recordState(codexHome) {
  const blocked = directoryProblem(codexHome, RECORD_REL);
  if (blocked) return { error: blocked };
  return attempt(() => readCodexRecord(atHome(codexHome, RECORD_REL), codexHome));
}

function recordLine(record) {
  // A record written before pluginVersion existed (or with an unreported version) has the plugin, at an unknown version.
  const unknownVersion = record.pluginId && (record.pluginVersion === undefined || record.pluginVersion === null);
  if (unknownVersion || record.pluginVersion === record.version) return `Install record: Useful Skills ${record.version}.`;
  const plugin = record.pluginVersion ? `the plugin is recorded at ${record.pluginVersion}` : "no plugin is recorded";
  return `Install record: Useful Skills ${record.version} files, but ${plugin}: the install did not finish; run \`${INSTALL_COMMAND}\`.`;
}

function fileLine(codexHome, files) {
  const counts = { ok: 0, modified: 0, missing: 0, blocked: 0 };
  for (const [rel, sha] of Object.entries(files)) counts[ownedState(codexHome, rel, sha).state] += 1;
  return `Files: ${counts.ok} ok, ${counts.modified} modified, ${counts.missing} missing${counts.blocked > 0 ? `, ${counts.blocked} blocked by a symlink` : ""}.`;
}

/** One summary line for the seven agent files, then one line per agent that is not as installed. */
function agentLines(codexHome, files) {
  const states = AGENT_RELS.map((rel) => {
    if (files[rel]) return [rel, ownedState(codexHome, rel, files[rel]).state];
    return [rel, lstatOrNull(atHome(codexHome, rel)) ? "not installed by Useful Skills" : "missing"];
  });
  const ok = states.filter(([, state]) => state === "ok").length;
  if (states.every(([, state]) => state === "missing")) return [`Agents: none of the ${AGENT_RELS.length} in ${path.join(codexHome, "agents")}.`];
  return [
    `Agents: ${ok} of ${AGENT_RELS.length} ok in ${path.join(codexHome, "agents")}.`,
    ...states.filter(([, state]) => state !== "ok").map(([rel, state]) => `  ${path.basename(rel)}: ${state}`),
  ];
}

function pluginLine(plugin, record) {
  if (plugin.error) return `Plugin ${PLUGIN_ID}: cannot be checked (${plugin.error}).`;
  if (!plugin.value) return `Plugin ${PLUGIN_ID}: not installed.`;

  const { enabled, version } = plugin.value;
  let versionNote = "";
  if (record) versionNote = version === record.version ? " (matches the install record)" : ` (stale: the installed files are ${record.version}; run \`${INSTALL_COMMAND}\`)`;
  return `Plugin ${PLUGIN_ID}: installed, ${enabled ? "enabled" : "disabled"}, version ${version ?? "unknown"}${versionNote}.`;
}

function marketplaceLine(codexHome, marketplace) {
  if (marketplace.error) return `Marketplace ${MARKETPLACE_NAME}: cannot be checked (${marketplace.error}).`;
  if (!marketplace.value) return `Marketplace ${MARKETPLACE_NAME}: not added.`;

  const ref = marketplaceRef(codexHome, MARKETPLACE_NAME);
  return `Marketplace ${MARKETPLACE_NAME}: added from ${marketplace.value.source ?? "an unknown source"}${ref ? ` at ${ref}` : ""}.`;
}

function mcpLine(codexHome, mcp, record) {
  const name = mcpEntryFor(codexHome).name;
  if (mcp.error) return `MCP server ${name}: cannot be checked (${mcp.error}).`;
  if (!mcp.value) return `MCP server ${name}: not registered.`;

  const expected = record?.mcp ?? mcpEntryFor(codexHome);
  const state = sameMcp(mcp.value, expected) ? "registered as installed" : "registered, but not as Useful Skills installed it";
  return `MCP server ${name}: ${state}${mcp.value.enabled === false ? " (disabled)" : ""}.`;
}

/** One line for the models file, then one per role agent that does not inherit. */
function modelLines(codexHome) {
  const models = readCodexModels(codexHome);
  if (models.error) return [`Model roles: ${models.configFile} cannot be used (${models.error}); agents are installed without models.`];

  const lines = [`Model roles: ${models.configFile}${models.exists ? "" : " (not created yet; every role inherits)"}.`];
  for (const rel of AGENT_RELS) {
    const role = path.basename(rel, ".toml").slice("us-".length);
    const selection = selectionFor(role, models.roles);
    if (selection.model || selection.effort) lines.push(`  us-${role}: ${describeSelection(selection)}.`);
  }
  return lines;
}

/** What an install from before the rename left: its record, its plugin and MCP server in Codex, and its folder. */
function legacyLines(codexHome, client) {
  const lines = [];
  const legacy = readLegacyRecord(codexHome);
  if (legacy.record) lines.push(`Earlier install: Useful Skills ${legacy.record.version} is still recorded at ${atHome(codexHome, LEGACY_LAYOUT.recordRel)}; run \`${INSTALL_COMMAND}\` to replace it.`);
  if (legacy.problem) lines.push(`Earlier install: its record cannot be used (${legacy.problem}).`);

  if (client) {
    const plugin = attempt(() => client.listPlugins().find((item) => item.pluginId === LEGACY_LAYOUT.pluginId && item.installed));
    if (plugin.value) lines.push(`Earlier install: plugin ${LEGACY_LAYOUT.pluginId} is still installed; run \`${INSTALL_COMMAND}\` to replace it.`);
    const mcp = attempt(() => client.getMcp(LEGACY_LAYOUT.mcpName));
    if (mcp.value) lines.push(`Earlier install: MCP server ${LEGACY_LAYOUT.mcpName} is still registered; run \`${INSTALL_COMMAND}\` to replace it.`);
  }

  if (lstatOrNull(atHome(codexHome, LEGACY_DATA_DIRECTORY))) lines.push(`Earlier install: ${atHome(codexHome, LEGACY_DATA_DIRECTORY)} still exists.`);
  return lines;
}

function dataLine(dataDir) {
  const stat = lstatOrNull(dataDir);
  const state = !stat ? "missing" : stat.isDirectory() ? `present, mode ${(stat.mode & 0o777).toString(8)}` : "not a directory";
  return `Data directory: ${dataDir} (${state}).`;
}

/** The Codex part of the report, given a working `codex` and an existing home. */
function codexLines(client, codexHome, record) {
  const plugin = attempt(() => client.listPlugins().find((item) => item.pluginId === PLUGIN_ID && item.installed));
  const marketplace = attempt(() => client.listMarketplaces().find((item) => item.name === MARKETPLACE_NAME));
  const mcp = attempt(() => client.getMcp(mcpEntryFor(codexHome).name));
  const lines = [pluginLine(plugin, record), marketplaceLine(codexHome, marketplace), mcpLine(codexHome, mcp, record)];
  if (plugin.value && !record) {
    lines.push(`The plugin is installed without the Useful Skills installer: skills only; memory tools and agents unavailable; run \`${INSTALL_COMMAND}\`.`);
  }
  return lines;
}

/** Append the report lines after the header; may throw on an unreadable file, which the caller reports. */
function reportLines(environment, lines) {
  const version = attempt(() => codexClient({ environment }).version());
  lines.push(`Codex CLI: ${version.value ?? (version.error === CODEX_MISSING ? "not found on PATH" : `cannot be run (${version.error})`)}`);

  const home = attempt(() => codexHomeFor(environment));
  if (home.error) {
    lines.push(`Codex home: cannot be used (${home.error})`);
    return;
  }

  if (!lstatOrNull(home.value)) {
    lines.push(`Codex home: ${home.value} (missing); Useful Skills is not installed.`);
    return;
  }

  const codexHome = attempt(() => realpathSync(home.value)).value ?? home.value;
  lines.push(`Codex home: ${codexHome}`);
  const record = recordState(codexHome);
  if (record.error) lines.push(`Install record: cannot be used (${record.error}); run \`${INSTALL_COMMAND}\` after moving it away.`);
  else if (!record.value) lines.push(`Install record: none at ${atHome(codexHome, RECORD_REL)}; Useful Skills is not installed by its installer.`);
  else lines.push(recordLine(record.value));

  const files = record.value?.files ?? {};
  if (record.value) lines.push(fileLine(codexHome, files));
  lines.push(...agentLines(codexHome, files));
  if (version.value) lines.push(...codexLines(codexClient({ environment, codexHome }), codexHome, record.value));
  else lines.push("Plugin, marketplace and MCP server: not checked without the codex command.");

  lines.push(dataLine(record.value?.dataDir ?? mcpEntryFor(codexHome).env.USEFUL_SKILLS_DATA));
  lines.push(...modelLines(codexHome));
  lines.push(...legacyLines(codexHome, version.value ? codexClient({ environment, codexHome }) : undefined));
}

/** Read-only health summary of the Codex install: `{text}`. Never throws; a damaged install is reported. */
export function inspectCodexInstall({ environment = process.env } = {}) {
  const lines = ["Codex install"];
  try {
    reportLines(environment, lines);
  } catch (error) {
    lines.push(`The install cannot be inspected further (${reason(error)}).`);
  }

  lines.push(TIMEOUT_NOTE);
  return { text: printableText(lines.join("\n")) };
}
