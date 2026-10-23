import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { migrateDataDirectory, migrateDirectory } from "../data-migration.js";
import { LEGACY_MCP_SERVER_NAME } from "../legacy-names.js";
import { ensurePrivateDirectory, readOptional, writeAtomic } from "../model-roles.js";
import { DATA_DIRECTORY, PLUGIN_NAME } from "../names.js";
import { MCP_NAME, chooseConfigFile, mcpEntryFor, mcpSnippet, planMcpUpsert, readConfigFile, writeConfigAtomic } from "./config-file.js";
import { applyPlan, checkedRecordPath, planFiles, pruneEmptyDirectories, readBundle, recordText, resolveScopeRoot } from "./install-files.js";
import { readLegacyRecord } from "./legacy.js";
import { syncOpenCodeAgents } from "./models.js";
import { defaultDataDir, isPrintable, legacyDataDir, legacyInstallRecordPath, opencodeConfigDir, printableText, readInstallRecord, scopeRootFor } from "./paths.js";
import { removeMcpEntry } from "./uninstall.js";

const DEFAULT_BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "opencode");

const sortedFiles = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));

/** Add or refresh `mcp.harness-useful-skills`, reporting rather than guessing when the config cannot be edited safely. */
function editConfig({ file, warning }, entry) {
  const lines = warning ? [`Warning: ${warning}`] : [];
  const refused = (reason) => ({
    actionRequired: true,
    file,
    lines: [
      ...lines,
      `Action required: ${file} was not changed (${reason}).`,
      `Add this to it yourself, merging into any existing "mcp" object:`,
      mcpSnippet(entry),
    ],
  });

  let text;
  let plan;
  try {
    text = readConfigFile(file);
    plan = planMcpUpsert(text, entry);
  } catch (error) {
    return refused(error.message);
  }
  if (plan.action === "refuse") return refused(plan.reason);
  if (plan.action === "unchanged") return { file, lines: [...lines, `MCP server ${MCP_NAME} is already set in ${file}.`] };

  // The edit round-trips through JSON.parse/stringify: indentation is normalized to two spaces, duplicate keys collapse
  // and numbers beyond double precision are rounded. Key order and every other value are kept. Another writer racing
  // this edit is caught by writeConfigAtomic's re-check, which leaves only a tiny window before the rename.

  try {
    writeConfigAtomic(file, plan.text, text);
  } catch (error) {
    return refused(error.message);
  }
  if (plan.previous !== undefined) {
    lines.push(`Replaced the existing mcp.${MCP_NAME} in ${file}; it was:`, JSON.stringify(plan.previous, null, 2));
  }
  lines.push(`MCP server ${MCP_NAME} ${plan.action === "create" ? "written to the new" : "set in"} ${file}.`);
  return { file, lines, created: plan.action === "create" };
}

function assertPrintablePaths(paths) {
  if (!isPrintable(paths)) {
    throw new Error("Refusing to install; nothing was changed: a target path contains control characters. Use a directory without them.");
  }
}

function agentLines(sync) {
  if (sync.blocked) return [`Agents were not generated: ${sync.blocked}.`];
  if (sync.error) return [`Agents were not generated: ${sync.configFile} is invalid (${sync.error}).`];
  const counts = {};
  const lines = [];
  for (const { state, file } of Object.values(sync.agents)) {
    counts[state] = (counts[state] ?? 0) + 1;
    if (state === "conflict") lines.push(`Left ${file} alone: Useful Skills did not generate it.`);
  }
  const summary = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(", ");
  return [`Agents: ${summary}.`, ...lines];
}

/**
 * Carry an install from before the rename over to the current names: move its data and settings (never a file that
 * differs from the one already in the new place), drop its MCP entry and its record. Its files were handled by the
 * install plan, which treats them as owned. Returns report lines.
 */
function migrateLegacyInstall({ scopeRoot, legacy, environment, dataDir }) {
  const lines = legacy.problem ? [`Left the earlier install alone: its record cannot be used (${legacy.problem}).`] : [];

  // The memory folder inside the data directory is renamed first, so the environment cache it holds is not copied.
  const legacyData = legacy.record?.dataDir ?? legacyDataDir(environment);
  migrateDataDirectory(legacyData);
  const moved = [
    migrateDirectory(legacyData, dataDir),
    migrateDataDirectory(dataDir),
    migrateDataDirectory(opencodeConfigDir(environment)),
    migrateDataDirectory(scopeRoot),
  ];
  for (const kept of moved.flatMap((result) => result.kept)) {
    lines.push(`Left ${kept} in place: it differs from the file at the new location. Compare them and delete the old one.`);
  }

  if (legacy.record) {
    lines.push(...removeMcpEntry(scopeRoot, legacy.record, { name: LEGACY_MCP_SERVER_NAME, keepConfigFile: true }));
    const recordFile = legacyInstallRecordPath(scopeRoot);
    rmSync(recordFile);
    pruneEmptyDirectories(scopeRoot, recordFile);
  }

  return lines;
}

/**
 * Install the OpenCode plugin bundle into a scope and register the memory MCP server.
 * Throws, before writing anything, when a target exists that Useful Skills does not own, an owned file was edited,
 * or a path component is a symlink. A config edit that cannot be made safely is reported as `actionRequired`.
 * Returns `{message, actionRequired}`.
 */
export function installOpenCode({ scope = "user", cwd = process.cwd(), environment = process.env, bundleRoot = DEFAULT_BUNDLE } = {}) {
  const bundle = readBundle(bundleRoot);
  // The install record stores these paths and refuses control characters, so refuse them before creating anything.
  assertPrintablePaths([scopeRootFor({ scope, cwd, environment }), defaultDataDir(environment), opencodeConfigDir(environment)]);
  const scopeRoot = resolveScopeRoot({ scope, cwd, environment, create: true });
  assertPrintablePaths([scopeRoot]);
  const recordFile = checkedRecordPath(scopeRoot);

  const previous = readInstallRecord(recordFile);
  // An install from before the rename owns its files too: unchanged ones are replaced or removed, edited ones are kept.
  const legacy = readLegacyRecord(scopeRoot);
  const owned = { ...legacy.record?.files, ...previous?.files };
  const plan = planFiles(scopeRoot, bundle, owned);
  if (plan.problems.length > 0) {
    throw new Error(printableText(`Refusing to install; nothing was changed:\n${plan.problems.map((problem) => `  ${problem}`).join("\n")}\nMove or remove these, or restore the files Useful Skills installed, then run the install again.`));
  }

  const entry = mcpEntryFor(scopeRoot);
  const dataDir = defaultDataDir(environment);
  const chosen = chooseConfigFile(scopeRoot);
  const files = { ...owned };
  // Whether this installer created the config file, so uninstall may delete it again once only `$schema` is left.
  const created = previous ?? legacy.record;
  let configCreated = created?.configCreated === true && created.configFile === chosen.file;
  const saveRecord = () => {
    const text = recordText({ schema: 1, version: bundle.version, scope, scopeRoot, dataDir, configFile: chosen.file, mcpEntry: entry, configCreated, files: sortedFiles(files) });
    if (readOptional(recordFile) !== text) writeAtomic(recordFile, text);
  };

  try {
    applyPlan(scopeRoot, plan, files);
  } catch (error) {
    try {
      saveRecord();
    } catch {
      // The write failure above is the one to report; the record only keeps later runs truthful.
    }
    throw error;
  }
  saveRecord();

  const migration = migrateLegacyInstall({ scopeRoot, legacy, environment, dataDir });
  ensurePrivateDirectory(dataDir);
  // Workflow settings always live in the user config dir, even for a project install; create it so they stay writable.
  ensurePrivateDirectory(path.join(opencodeConfigDir(environment), DATA_DIRECTORY));

  const sync = syncOpenCodeAgents({ scopeRoot, templatesDir: path.join(scopeRoot, "plugins", PLUGIN_NAME, "opencode", "agents") });
  const config = editConfig(chosen, entry);
  if (config.created) {
    configCreated = true;
    saveRecord();
  }

  const changed = plan.writes.length + plan.stale.length;
  const lines = [
    changed === 0
      ? `Useful Skills ${bundle.version} is already installed for OpenCode (${scope} scope) in ${scopeRoot}; nothing to update.`
      : `Installed Useful Skills ${bundle.version} for OpenCode (${scope} scope) in ${scopeRoot}: ${plan.writes.length} files written, ${plan.unchanged.length} unchanged, ${plan.stale.length} stale removed.`,
    ...[...plan.kept].map((note) => `Left a stale file from an earlier install in place: ${note}`),
    ...migration,
    ...agentLines(sync),
    ...config.lines,
    `Data directory: ${dataDir}`,
  ];
  if (scope === "project") {
    lines.push(`The MCP path written to ${config.file} is specific to this machine; consider adding .opencode/ to .gitignore.`);
  }
  lines.push("Restart OpenCode to load it.");
  return { message: printableText(lines.join("\n")), actionRequired: config.actionRequired === true };
}
