/**
 * Where the Useful Skills installer for Codex puts things, and how it reads its install record. Installer-only:
 * the Codex runtime (codex/mcp-server.js and its closure) never imports this module.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPlainRelativePath } from "../path-boundary.js";
import { isPrintable } from "../opencode/paths.js";
import { AGENT_ROLES } from "./agents.js";

/** The package this module runs from: a checkout or an extracted release, holding `plugins/codex*` and `.agents/plugins`. */
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const MARKETPLACE_NAME = "harness-useful-skills";
export const PLUGIN_ID = `useful-skills@${MARKETPLACE_NAME}`;
export const MCP_NAME = "useful_skills";
export const GITHUB_SOURCE = "MSpiechowicz/harness-useful-skills";

/** CODEX_HOME-relative locations; the record lists files with the same `/`-separated paths. */
export const RUNTIME_DIR = "useful-skills/runtime";
export const RECORD_REL = "useful-skills/install-record.json";
export const DATA_REL = "useful-skills/data";
export const MCP_SERVER_REL = `${RUNTIME_DIR}/codex/mcp-server.js`;
export const agentRel = (role) => `agents/us-${role}.toml`;
export const AGENT_RELS = Object.freeze(AGENT_ROLES.map(agentRel));

export const INSTALL_COMMAND = "./useful-skills install --host codex";
export const TIMEOUT_NOTE = "Long graph builds can exceed Codex's MCP tool timeout; raise tool_timeout_sec under [mcp_servers.useful_skills] in config.toml if they do (the installer never edits config.toml).";

const RECORD_MAX_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Codex's home directory: CODEX_HOME when set, else `<home>/.codex`, without resolving links or creating anything.
 * Throws for a relative CODEX_HOME (Codex would read it against the working directory) and for control characters.
 */
export function codexHomeFor(environment = process.env) {
  const configured = environment.CODEX_HOME;
  let home;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) throw new Error("CODEX_HOME must be an absolute path.");
    home = path.resolve(configured);
  } else {
    const user = environment.HOME && path.isAbsolute(environment.HOME) ? environment.HOME : os.homedir();
    home = path.join(user, ".codex");
  }

  if (!isPrintable(home)) throw new Error("The Codex home directory contains control characters; use a directory without them.");
  return home;
}

/** `<codexHome>/<rel>` for a `/`-separated relative path. */
export const atHome = (codexHome, rel) => path.join(codexHome, ...rel.split("/"));

/** The MCP server registration for an install in `codexHome`, as recorded and as `codex mcp get` reports it. */
export function mcpEntryFor(codexHome) {
  return { name: MCP_NAME, command: "node", args: [atHome(codexHome, MCP_SERVER_REL)], env: { USEFUL_SKILLS_DATA: atHome(codexHome, DATA_REL) } };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value) => typeof value === "string" && value !== "";
const isStringMap = (value) => isRecord(value) && Object.values(value).every((item) => typeof item === "string");

function validMarketplace(entry) {
  if (entry === null) return true;
  return isRecord(entry) && entry.name === MARKETPLACE_NAME && isString(entry.source) && (entry.ref === null || isString(entry.ref)) && typeof entry.addedByInstaller === "boolean";
}

/** The recorded MCP server must be exactly the one this installer registers for `codexHome`. */
function validMcp(entry, codexHome) {
  if (entry === null) return true;
  if (!isRecord(entry) || !Array.isArray(entry.args) || !isStringMap(entry.env)) return false;
  const expected = mcpEntryFor(codexHome);
  return entry.name === expected.name && entry.command === expected.command && JSON.stringify(entry.args) === JSON.stringify(expected.args)
    && JSON.stringify(entry.env) === JSON.stringify(expected.env);
}

/** Only the runtime tree and the seven agent files can be owned; anything else in CODEX_HOME (auth, config, sessions) never is. */
const ownableFile = (rel) => isPlainRelativePath(rel) && (rel.startsWith(`${RUNTIME_DIR}/`) || AGENT_RELS.includes(rel));

function sameDirectory(a, b) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Whether `record` is one this installer could have written for `codexHome`. A crafted record must not steer install
 * or uninstall at files, plugins, marketplaces or MCP servers outside what Useful Skills owns.
 */
function validRecord(record, codexHome) {
  if (!isRecord(record) || record.schema !== 1 || typeof record.version !== "string" || !STABLE_VERSION.test(record.version)) return false;
  if (!isString(record.codexHome) || !path.isAbsolute(record.codexHome) || !sameDirectory(record.codexHome, codexHome)) return false;
  if (record.dataDir !== atHome(record.codexHome, DATA_REL)) return false;
  if (!validMarketplace(record.marketplace) || !validMcp(record.mcp, record.codexHome)) return false;
  if (record.pluginId !== null && record.pluginId !== PLUGIN_ID) return false;
  if (record.pluginVersion !== undefined && record.pluginVersion !== null && !isString(record.pluginVersion)) return false;
  if (!isRecord(record.files)) return false;

  // Status and uninstall print the record, so a crafted one must not smuggle terminal escapes in.
  if (!isPrintable(record)) return false;
  return Object.entries(record.files).every(([file, digest]) => ownableFile(file) && typeof digest === "string" && SHA256.test(digest));
}

/**
 * Read the Codex install record of `codexHome` without following a symbolic link or blocking on a FIFO. Returns null
 * when the file does not exist and throws when it is not a small regular file holding a valid record for that home.
 */
export function readCodexRecord(file, codexHome) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(error?.code === "ELOOP" ? "The Codex install record must not be a symbolic link." : "Cannot read the Codex install record.");
  }

  let text;
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error("The Codex install record must be a regular file.");
    if (details.size > RECORD_MAX_BYTES) throw new Error("The Codex install record is too large.");
    text = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error("The Codex install record is not valid JSON.");
  }

  if (!validRecord(record, codexHome)) throw new Error("The Codex install record has an unexpected format.");
  return record;
}
