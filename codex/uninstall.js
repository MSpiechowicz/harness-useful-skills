import { realpathSync, rmSync } from "node:fs";

import { writeAtomic } from "../model-roles.js";
import { leftNote, ownedState, pruneEmptyDirectories, recordText, removeOwned } from "../opencode/install-files.js";
import { directoryProblem, lstatOrNull, printableText } from "../opencode/paths.js";
import { CodexMissingError, codexClient, sameMcp, sameSource } from "./codex-cli.js";
import { LEGACY_LAYOUT, MODELS_REL, PLUGIN_ID, RECORD_REL, atHome, codexHomeFor, readCodexRecord, readLegacyRecord } from "./paths.js";

/** Remove the recorded files that are still byte-identical to what was installed; list the rest. */
function removeFiles(codexHome, record) {
  const result = { removed: 0, left: [] };
  for (const [rel, sha] of Object.entries(record.files)) {
    const owned = ownedState(codexHome, rel, sha);
    if (owned.state === "ok") {
      removeOwned(codexHome, rel);
      result.removed += 1;
    } else if (owned.state !== "missing") {
      result.left.push(leftNote(codexHome, rel, owned));
    }
  }
  return result;
}

/** Unregister the MCP server, the plugin and the marketplace as recorded, saving the record after each step. */
function unregister(client, record, save, pluginId = PLUGIN_ID) {
  const lines = [];
  if (record.mcp) {
    const live = client.getMcp(record.mcp.name);
    if (!live) lines.push(`MCP server ${record.mcp.name} was already gone.`);
    else if (sameMcp(live, record.mcp)) {
      client.removeMcp(record.mcp.name);
      lines.push(`Removed MCP server ${record.mcp.name}.`);
    } else {
      lines.push(`Left MCP server ${record.mcp.name} alone: it is no longer what Useful Skills registered.`);
    }
    record.mcp = null;
    save();
  }

  // A null pluginId means the install stopped before `plugin add`; a plugin present now is the user's own.
  if (record.pluginId) {
    client.removePlugin(record.pluginId);
    lines.push(`Removed plugin ${record.pluginId}.`);
    record.pluginId = null;
    save();
  } else {
    lines.push(`Left plugin ${pluginId} alone: this install did not add it.`);
  }

  const marketplace = record.marketplace;
  if (marketplace?.addedByInstaller) {
    const live = client.listMarketplaces().find((item) => item.name === marketplace.name);
    if (!live) lines.push(`Marketplace ${marketplace.name} was already gone.`);
    else if (sameSource(live.source, marketplace.source)) {
      client.removeMarketplace(marketplace.name);
      lines.push(`Removed marketplace ${marketplace.name}.`);
    } else {
      lines.push(`Left marketplace ${marketplace.name} alone: it now comes from ${live.source ?? "an unknown source"}.`);
    }
  } else if (marketplace) {
    lines.push(`Kept marketplace ${marketplace.name}: it was added before Useful Skills was installed.`);
  }
  record.marketplace = null;
  save();
  return lines;
}

/**
 * Remove a Codex install under the current name and any left from before the rename: the MCP server if it is still
 * what was registered, the plugin, the marketplace if this installer added it, then the unmodified recorded files and
 * the record. Modified files, the data directory and the models file are kept.
 * Resolves to `{message}`; throws without removing files when a Codex command fails.
 */
export function uninstallCodex({ environment = process.env } = {}) {
  const configured = codexHomeFor(environment);
  const codexHome = lstatOrNull(configured) ? realpathSync(configured) : configured;
  const recordFile = atHome(codexHome, RECORD_REL);
  const blocked = directoryProblem(codexHome, RECORD_REL);
  if (blocked) throw new Error(printableText(`${blocked}; Useful Skills will not read an install record through it.`));

  let record;
  try {
    record = readCodexRecord(recordFile, codexHome);
  } catch (error) {
    throw new Error(printableText(`${error.message} Nothing was removed; move ${recordFile} away if it is not from this installer.`));
  }

  const legacy = readLegacyRecord(codexHome);
  const installs = [
    record && { record, recordFile, pluginId: PLUGIN_ID },
    legacy.record && { record: legacy.record, recordFile: atHome(codexHome, LEGACY_LAYOUT.recordRel), pluginId: LEGACY_LAYOUT.pluginId },
  ].filter(Boolean);
  if (installs.length === 0) {
    const note = legacy.problem ? ` The record of the earlier install was not used (${legacy.problem}).` : "";
    return { message: printableText(`Useful Skills is not installed for Codex: no install record at ${recordFile}. Nothing was removed.${note}`) };
  }

  const client = codexClient({ environment, codexHome });
  try {
    client.version();
  } catch (error) {
    if (error instanceof CodexMissingError) throw new Error("The codex command was not found on PATH; uninstalling needs it to remove the plugin and the MCP server. Nothing was removed.");
    throw error;
  }

  const lines = [];
  for (const install of installs) {
    try {
      lines.push(...unregister(client, install.record, () => writeAtomic(install.recordFile, recordText(install.record)), install.pluginId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(printableText(`${message}\nThe uninstall stopped before removing files. ${install.recordFile} records what is still in place; fix the cause and run \`./useful-skills uninstall --host codex\` again.`));
    }
  }

  const removed = { removed: 0, left: [] };
  for (const install of installs) {
    const files = removeFiles(codexHome, install.record);
    removed.removed += files.removed;
    removed.left.push(...files.left);
    rmSync(install.recordFile);
    pruneEmptyDirectories(codexHome, install.recordFile);
  }

  const keep = [...new Set(installs.map(({ record: each }) => each.dataDir))].filter((dataDir) => lstatOrNull(dataDir));
  const kept = keep.map((dataDir) => `Kept the data directory ${dataDir} (project memory); delete it yourself if you no longer need it.`);
  const models = lstatOrNull(atHome(codexHome, MODELS_REL)) ? [`Kept the model roles file ${atHome(codexHome, MODELS_REL)}.`] : [];
  const versions = installs.map(({ record: each }) => each.version).join(" and ");
  return {
    message: printableText([
      `Uninstalled Useful Skills ${versions} from Codex in ${codexHome}: ${removed.removed} files removed.`,
      ...lines,
      ...(removed.left.length > 0 ? ["Left in place for you to review or delete:", ...removed.left.map((item) => `  ${item}`)] : []),
      ...kept,
      ...models,
      "Restart Codex.",
    ].join("\n")),
  };
}
