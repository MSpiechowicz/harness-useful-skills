import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { ensurePrivateDirectory, readOptional, writeAtomic } from "../model-roles.js";
import { applyPlan, planFiles, recordText, sha256 } from "../opencode/install-files.js";
import { directoryProblem, isPrintable, lstatOrNull, printableText } from "../opencode/paths.js";
import { AGENT_MARKER, readAgents } from "./agents.js";
import { codexClient, marketplaceRef, releaseTagState, sameMcp, sameSource } from "./codex-cli.js";
import { AGENT_RELS, DATA_REL, GITHUB_SOURCE, INSTALL_COMMAND, MARKETPLACE_NAME, PACKAGE_ROOT, PLUGIN_ID, RECORD_REL, RUNTIME_DIR, agentRel, atHome, codexHomeFor, mcpEntryFor, readCodexRecord } from "./paths.js";

const PLUGIN_MANIFEST = "plugins/codex/.codex-plugin/plugin.json";
const RUNTIME_BUNDLE = "plugins/codex-runtime/useful-skills";
const MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

const sortedFiles = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const describeSource = ({ source, ref }) => (ref ? `${source} at ${ref}` : source);

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Cannot read ${what} at ${file}.`);
  }
}

function readTree(directory, prefix, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) readTree(target, rel, files);
    else if (entry.isFile()) files.set(rel, readFileSync(target));
    else throw new Error(`The bundle contains ${target}, which is neither a regular file nor a directory.`);
  }
}

/**
 * Read what the installer copies: the runtime bundle under `<CODEX_HOME>/useful-skills/runtime` and the seven agent
 * files under `<CODEX_HOME>/agents`. Returns `{version, files}` with CODEX_HOME-relative paths.
 */
export async function readCodexBundle(packageRoot) {
  const manifest = readJson(path.join(packageRoot, PLUGIN_MANIFEST), "the Codex plugin manifest");
  if (manifest?.name !== "useful-skills" || typeof manifest.version !== "string" || !STABLE_VERSION.test(manifest.version)) {
    throw new Error(`${path.join(packageRoot, PLUGIN_MANIFEST)} must name useful-skills with a stable x.y.z version.`);
  }

  const runtimeRoot = path.join(packageRoot, RUNTIME_BUNDLE);
  if (!lstatOrNull(path.join(runtimeRoot, "codex", "mcp-server.js"))?.isFile()) {
    throw new Error(`${runtimeRoot} is not a Codex runtime bundle (expected codex/mcp-server.js).`);
  }

  const files = new Map();
  readTree(runtimeRoot, RUNTIME_DIR, files);
  for (const { role, text } of await readAgents(path.join(runtimeRoot, "codex", "agents"))) {
    files.set(agentRel(role), Buffer.from(text));
  }
  return { version: manifest.version, files };
}

/** The marketplace source to add: GitHub at the release tag, or this package root with `local`. */
function desiredSource(packageRoot, version, local) {
  if (!local) return { name: MARKETPLACE_NAME, source: GITHUB_SOURCE, ref: `v${version}` };

  const file = path.join(packageRoot, MARKETPLACE_FILE);
  if (readJson(file, "the marketplace manifest")?.name !== MARKETPLACE_NAME) {
    throw new Error(`${file} must define the ${MARKETPLACE_NAME} marketplace.`);
  }
  return { name: MARKETPLACE_NAME, source: realpathSync(packageRoot), ref: null };
}

/**
 * For a GitHub source, check before any write that the release tag exists, so an unreleased checkout fails early.
 * Returns report lines: empty when the tag exists, a note when it cannot be checked. Throws when it is absent.
 */
function checkReleaseTag(environment, desired) {
  if (!desired.ref) return [];

  const tag = releaseTagState({ environment, repository: desired.source, ref: desired.ref });
  if (tag.state === "absent") {
    throw new Error(`Refusing to install; nothing was changed: release tag ${desired.ref} does not exist on github.com/${desired.source}, so Codex cannot add the marketplace from it. From a checkout, install with \`${INSTALL_COMMAND} --local\` instead.`);
  }
  return tag.state === "unknown" ? [`Note: could not check that release tag ${desired.ref} exists (${tag.reason}); continuing.`] : [];
}

/** CODEX_HOME as a real directory, created (private) when missing; Codex refuses a CODEX_HOME that does not exist. */
function prepareCodexHome(home) {
  if (!lstatOrNull(home)) mkdirSync(home, { recursive: true, mode: 0o700 });

  const resolved = realpathSync(home);
  if (!statSync(resolved).isDirectory()) throw new Error(`${home} is not a directory.`);
  if (!isPrintable(resolved)) throw new Error("The Codex home directory contains control characters; use a directory without them.");
  return resolved;
}

/** The record's files, plus agent files that carry our marker but were not recorded (a lost record): those may be replaced. */
function adoptMarkedAgents(codexHome, files) {
  const adopted = { ...files };
  for (const rel of AGENT_RELS) {
    const target = atHome(codexHome, rel);
    if (adopted[rel] !== undefined || directoryProblem(codexHome, rel) || !lstatOrNull(target)?.isFile()) continue;
    const data = readFileSync(target);
    if (data.toString("utf8").split("\n")[0] === AGENT_MARKER) adopted[rel] = sha256(data);
  }
  return adopted;
}

/**
 * A problem line when the runtime directory holds bundle files that `owned` does not list and that differ from the
 * bundle (a lost or older record). The directory is installer-owned and holds no user data, so name it to move away.
 */
function unrecordedRuntime(codexHome, bundle, owned) {
  const unrecorded = [...bundle.files].some(([rel, data]) => {
    if (!rel.startsWith(`${RUNTIME_DIR}/`) || owned[rel] !== undefined || directoryProblem(codexHome, rel)) return false;
    const target = atHome(codexHome, rel);
    return lstatOrNull(target)?.isFile() === true && sha256(readFileSync(target)) !== sha256(data);
  });
  if (!unrecorded) return [];
  return [`${atHome(codexHome, RUNTIME_DIR)} holds runtime files the install record does not list (the record is missing or from another install). It holds no user data: move that directory away, then run the install again.`];
}

/**
 * What to do with the `harness-useful-skills` marketplace: `add`, `reuse` (with the entry to record), or `replace` an
 * earlier one this installer added. A marketplace of that name from another source is a `problem`.
 */
function planMarketplace({ live, liveRef, desired, recorded }) {
  if (!live) return { action: "add", entry: { ...desired, addedByInstaller: true } };
  if (!live.source) return { problem: `Codex already has a marketplace named ${MARKETPLACE_NAME} without a source; Useful Skills cannot tell where it comes from.` };

  const ours = recorded?.addedByInstaller === true && sameSource(recorded.source, live.source);
  const matches = sameSource(live.source, desired.source);
  if (matches && liveRef === desired.ref) return { action: "reuse", entry: { ...desired, addedByInstaller: ours } };
  if (ours) return { action: "replace", entry: { ...desired, addedByInstaller: true } };
  if (matches) {
    const note = `The existing marketplace ${MARKETPLACE_NAME} tracks ${liveRef ?? "its default branch"}, not ${desired.ref ?? "the local directory"}; the plugin version follows it.`;
    return { action: "reuse", entry: { ...desired, ref: liveRef, addedByInstaller: false }, note };
  }

  return {
    problem: `Codex already has a marketplace named ${MARKETPLACE_NAME} from ${describeSource({ source: live.source, ref: liveRef })}, which Useful Skills did not add. Remove it with \`codex plugin marketplace remove ${MARKETPLACE_NAME}\` if you no longer need it.`,
  };
}

/** The data directory is made private in place, so it must be a real directory (or absent), never a symlink. */
function dataDirProblem(codexHome) {
  const blocked = directoryProblem(codexHome, DATA_REL);
  if (blocked) return [blocked];

  const target = atHome(codexHome, DATA_REL);
  const stat = lstatOrNull(target);
  if (stat && !stat.isDirectory()) return [`${target} is ${stat.isSymbolicLink() ? "a symbolic link" : "not a directory"}; the data directory must be a real directory`];
  return [];
}

/** Check, before anything is written, that the files, the marketplace and the MCP server can be installed. */
function preflight({ codex, codexHome, bundle, previous, desired }) {
  const owned = adoptMarkedAgents(codexHome, previous?.files ?? {});
  const plan = planFiles(codexHome, bundle, owned, [RECORD_REL]);
  const problems = [...plan.problems, ...unrecordedRuntime(codexHome, bundle, owned), ...dataDirProblem(codexHome)];

  const live = codex.listMarketplaces().find((item) => item.name === MARKETPLACE_NAME);
  const marketplace = planMarketplace({ live, liveRef: live ? marketplaceRef(codexHome, MARKETPLACE_NAME) : null, desired, recorded: previous?.marketplace });
  if (marketplace.problem) problems.push(marketplace.problem);

  const mcp = mcpEntryFor(codexHome);
  const liveMcp = codex.getMcp(mcp.name);
  const mcpCurrent = sameMcp(liveMcp, mcp);
  if (liveMcp && !mcpCurrent && !sameMcp(liveMcp, previous?.mcp)) {
    problems.push(`Codex already has an MCP server named ${mcp.name} (${liveMcp.command ? [liveMcp.command, ...liveMcp.args].join(" ") : `${liveMcp.transport} transport`}) that Useful Skills did not register. Remove it with \`codex mcp remove ${mcp.name}\` if you no longer need it.`);
  }

  return { plan, problems, marketplace, live, mcp, mcpCurrent };
}

/**
 * After `marketplace add`, check that the source really provided `harness-useful-skills`. When it did not, remove what
 * the add created under another name and return why; returns undefined when all is well.
 */
function missingMarketplace(codex, before, desired) {
  const after = codex.listMarketplaces();
  if (after.some((item) => item.name === MARKETPLACE_NAME && sameSource(item.source, desired.source))) return undefined;

  const added = after.filter((item) => !before.has(item.name) && sameSource(item.source, desired.source));
  for (const item of added) codex.removeMarketplace(item.name);
  const found = added.length > 0 ? ` (it provides ${added.map((item) => item.name).join(", ")}, which was removed again)` : "";
  return `${describeSource(desired)} does not provide the ${MARKETPLACE_NAME} marketplace${found}.`;
}

/** Carry out the marketplace plan, keeping `record.marketplace` truthful after every step. Returns report lines. */
function applyMarketplace({ client, marketplace, desired, record, saveRecord }) {
  if (marketplace.action === "reuse") {
    record.marketplace = marketplace.entry;
    saveRecord();
    return [`Marketplace ${MARKETPLACE_NAME}: already added from ${describeSource(marketplace.entry)}.`, ...(marketplace.note ? [marketplace.note] : [])];
  }

  if (marketplace.action === "replace") {
    client.removeMarketplace(MARKETPLACE_NAME);
    record.marketplace = null;
    saveRecord();
  }

  const before = new Set(client.listMarketplaces().map((item) => item.name));
  client.addMarketplace(desired.source, desired.ref);
  record.marketplace = marketplace.entry;
  saveRecord();

  const missing = missingMarketplace(client, before, desired);
  if (missing) {
    record.marketplace = null;
    saveRecord();
    throw new Error(missing);
  }
  return [`Marketplace ${MARKETPLACE_NAME}: ${marketplace.action === "replace" ? "replaced; now" : "added from"} ${describeSource(desired)}.`];
}

/** The earlier install record, or null; refuses (nothing changed) one behind a symlink or one this installer cannot have written. */
function readPreviousRecord(codexHome, recordFile) {
  const blocked = directoryProblem(codexHome, RECORD_REL);
  if (blocked) throw new Error(printableText(`Refusing to install; nothing was changed: ${blocked}.`));

  try {
    return readCodexRecord(recordFile, codexHome);
  } catch (error) {
    throw new Error(printableText(`Refusing to install; nothing was changed: ${error.message} Move ${recordFile} away if it is not from this installer, then run the install again.`));
  }
}

/**
 * Install Useful Skills for Codex: copy the runtime and agents into CODEX_HOME, add the marketplace and plugin, and
 * register the memory MCP server. Refuses, before writing anything, when a target is not ours, a file we installed was
 * edited, a path is a symlink, or the marketplace or MCP name is taken. A failure later leaves a truthful record.
 * Resolves to `{message}`.
 */
export async function installCodex({ environment = process.env, packageRoot = PACKAGE_ROOT, local = false } = {}) {
  codexClient({ environment }).version();

  const configuredHome = codexHomeFor(environment);
  const bundle = await readCodexBundle(packageRoot);
  const desired = desiredSource(packageRoot, bundle.version, local);
  const notes = checkReleaseTag(environment, desired);

  const codexHome = prepareCodexHome(configuredHome);
  const client = codexClient({ environment, codexHome });
  const recordFile = atHome(codexHome, RECORD_REL);
  const previous = readPreviousRecord(codexHome, recordFile);

  const checked = preflight({ codex: client, codexHome, bundle, previous, desired });
  if (checked.problems.length > 0) {
    throw new Error(printableText(`Refusing to install; nothing was changed:\n${checked.problems.map((problem) => `  ${problem}`).join("\n")}\nMove or remove these, or restore the files Useful Skills installed, then run the install again.`));
  }

  const { plan, marketplace, mcp } = checked;
  const dataDir = atHome(codexHome, DATA_REL);
  const record = {
    schema: 1,
    version: bundle.version,
    codexHome,
    dataDir,
    files: { ...previous?.files },
    marketplace: previous?.marketplace ?? null,
    pluginId: previous?.pluginId ?? null,
    // `version` is the runtime and agents copied below; the plugin's version is recorded only once `plugin add` succeeds.
    pluginVersion: previous?.pluginVersion ?? null,
    mcp: previous?.mcp ?? null,
  };
  const saveRecord = () => {
    const text = recordText({ ...record, files: sortedFiles(record.files) });
    if (readOptional(recordFile) !== text) writeAtomic(recordFile, text);
  };

  const done = [];
  const lines = [];
  let stage = "copying the runtime and agents";
  try {
    try {
      applyPlan(codexHome, plan, record.files);
    } catch (error) {
      try {
        saveRecord();
      } catch {
        // The write failure above is the one to report; the record only keeps later runs truthful.
      }
      throw error;
    }
    saveRecord();
    ensurePrivateDirectory(dataDir);
    done.push(`${plan.writes.length + plan.unchanged.length} files in place`);

    stage = "adding the marketplace";
    lines.push(...applyMarketplace({ client, marketplace, desired, record, saveRecord }));
    done.push("marketplace ready");

    stage = "installing the plugin";
    const plugin = client.addPlugin(PLUGIN_ID);
    record.pluginId = plugin.pluginId;
    record.pluginVersion = plugin.version ?? bundle.version;
    saveRecord();
    lines.push(`Plugin ${plugin.pluginId} ${plugin.version ?? "(version not reported)"} installed.`);
    if (plugin.version && plugin.version !== bundle.version) lines.push(`Note: Codex installed plugin version ${plugin.version}, not ${bundle.version}.`);
    done.push("plugin installed");

    stage = "registering the MCP server";
    if (checked.mcpCurrent) {
      lines.push(`MCP server ${mcp.name} is already registered.`);
    } else {
      client.addMcp(mcp);
      lines.push(`MCP server ${mcp.name} registered: ${[mcp.command, ...mcp.args].join(" ")}.`);
    }
    record.mcp = mcp;
    saveRecord();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(printableText([
      message,
      `The install stopped while ${stage}. Done: ${done.length > 0 ? done.join(", ") : "nothing"}.`,
      `${recordFile} records what is in place. Fix the cause, then run \`${INSTALL_COMMAND}${local ? " --local" : ""}\` (or the install script) again.`,
    ].join("\n")));
  }

  const changed = plan.writes.length + plan.stale.length;
  const summary = changed === 0
    ? `Useful Skills ${bundle.version} for Codex in ${codexHome}: files already up to date.`
    : `Installed Useful Skills ${bundle.version} for Codex in ${codexHome}: ${plan.writes.length} files written, ${plan.unchanged.length} unchanged, ${plan.stale.length} stale removed.`;
  return {
    message: printableText([
      summary,
      ...notes,
      ...[...plan.kept].map((note) => `Left a stale file from an earlier install in place: ${note}`),
      ...lines,
      `Agents: ${AGENT_RELS.map((rel) => path.basename(rel, ".toml")).join(", ")} in ${path.join(codexHome, "agents")}.`,
      `Data directory: ${dataDir}`,
      "Restart Codex to load it.",
    ].join("\n")),
  };
}
