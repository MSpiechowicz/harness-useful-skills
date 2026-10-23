import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { MCP_SERVER_NAME, PLUGIN_NAME } from "../names.js";

/** The key under OpenCode's top-level `mcp` object that names our memory server. */
export const MCP_NAME = MCP_SERVER_NAME;
export const CONFIG_CANDIDATES = Object.freeze(["opencode.json", "opencode.jsonc"]);

const MAX_CONFIG_BYTES = 1024 * 1024;
const MCP_TIMEOUT_MS = 600_000;
const SCHEMA_URL = "https://opencode.ai/config.json";

/** The MCP server entry the installer writes; graph builds can run for minutes, hence the long timeout. */
export function mcpEntryFor(scopeRoot) {
  return {
    type: "local",
    command: ["node", path.join(scopeRoot, "plugins", PLUGIN_NAME, "opencode", "mcp-server.js")],
    enabled: true,
    timeout: MCP_TIMEOUT_MS,
  };
}

/** Snippet a user can paste into their config when we may not edit it ourselves. */
export function mcpSnippet(entry, name = MCP_NAME) {
  return JSON.stringify({ mcp: { [name]: entry } }, null, 2);
}

/**
 * Read a config file without following a symlink. Returns undefined when it does not exist and throws
 * a message-bearing Error for a symlink, non-regular file, or file over 1 MiB.
 */
export function readConfigFile(file) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "ELOOP") throw new Error(`${file} is a symbolic link.`);
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file.`);
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${file} is larger than 1 MiB.`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Pick the config file to edit in `dir`: opencode.json when present, else opencode.jsonc, else a new
 * opencode.json. `warning` is set when the file we did not pick also mentions our server.
 */
export function chooseConfigFile(dir) {
  const [json, jsonc] = CONFIG_CANDIDATES.map((name) => path.join(dir, name));
  const exists = (file) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  const file = exists(json) || !exists(jsonc) ? json : jsonc;
  const other = file === json ? jsonc : json;

  let warning;
  try {
    if (readConfigFile(other)?.includes(MCP_NAME)) {
      warning = `${other} also mentions ${MCP_NAME}; OpenCode merges both files, so check that entry by hand.`;
    }
  } catch {
    // An unreadable alternate file is reported when someone edits it; it must not block this choice.
  }
  return { file, warning };
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Edits re-serialize the parsed config: indentation is normalized to two spaces, duplicate keys collapse to the last one
// and numbers beyond double precision are rounded. Key order and all other values survive.
const render = (config) => `${JSON.stringify(config, null, 2)}\n`;

/** Strictly parse a config; comments, bad JSON, or a non-object are refused rather than guessed at. */
function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { reason: "it is not strict JSON (comments, trailing commas, or a syntax error), so it was not edited" };
  }
  if (!isPlainObject(config)) return { reason: "its top level is not a JSON object" };
  if (config.mcp !== undefined && !isPlainObject(config.mcp)) return { reason: "its `mcp` value is not an object" };
  return { config };
}

/**
 * Plan adding or replacing `mcp.<name>` (our memory server unless `name` says otherwise). `text` is the current file text, undefined when the file does not exist.
 * Returns `{action: "create"|"update"|"unchanged", text, previous?}` or `{action: "refuse", reason}`; every other key is kept.
 */
export function planMcpUpsert(text, entry, name = MCP_NAME) {
  if (text === undefined) {
    return { action: "create", text: render({ $schema: SCHEMA_URL, mcp: { [name]: entry } }) };
  }
  const { config, reason } = parseConfig(text);
  if (reason) return { action: "refuse", reason };

  const previous = config.mcp?.[name];
  if (isDeepStrictEqual(previous, entry)) return { action: "unchanged", text };
  config.mcp = { ...config.mcp, [name]: entry };
  return previous === undefined
    ? { action: "update", text: render(config) }
    : { action: "update", text: render(config), previous };
}

/**
 * Plan removing `mcp.<name>`, but only when it still equals `entry`.
 * Returns `{action: "remove", text}`, `{action: "absent"}`, `{action: "keep", current}` for a value we did not write,
 * or `{action: "refuse", reason}`.
 */
export function planMcpRemove(text, entry, name = MCP_NAME) {
  if (text === undefined) return { action: "absent" };
  const { config, reason } = parseConfig(text);
  if (reason) return { action: "refuse", reason };

  const current = config.mcp?.[name];
  if (current === undefined) return { action: "absent" };
  if (!isDeepStrictEqual(current, entry)) return { action: "keep", current };

  const { [name]: _removed, ...rest } = config.mcp;
  if (Object.keys(rest).length === 0) delete config.mcp;
  else config.mcp = rest;
  return { action: "remove", text: render(config) };
}

/** Whether `text` is a config holding nothing but `$schema`, which is what a config we created has once our entry is gone. */
export function isSchemaOnly(text) {
  const { config } = parseConfig(text);
  return config !== undefined && Object.keys(config).every((key) => key === "$schema");
}

/**
 * Throw unless the file still reads exactly as `original` (undefined means it must not exist). This is a check, not a
 * lock: a concurrent writer can still change the file between this read and the rename or delete that follows.
 */
function assertUnchanged(file, original) {
  if (readConfigFile(file) !== original) {
    throw new Error(`${file} changed while it was being edited; nothing was written.`);
  }
}

/**
 * Write `text` over `file` through an exclusive temporary file in the same directory, keeping the file's mode.
 * `original` is what the plan was made from; the write is refused when the file no longer matches it.
 * A new file is linked into place so it can never replace one created in the meantime.
 */
export function writeConfigAtomic(file, text, original) {
  const directory = path.dirname(file);
  if (!lstatSync(directory).isDirectory()) throw new Error(`${directory} is not a real directory.`);
  assertUnchanged(file, original);

  const mode = original === undefined ? 0o644 : lstatSync(file).mode & 0o777;
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(descriptor, text);
      fchmodSync(descriptor, mode);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertUnchanged(file, original);
    if (original === undefined) linkSync(temporary, file);
    else renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Delete `file`, refusing when it no longer reads exactly as `original`. Same check-then-act window as writeConfigAtomic. */
export function deleteConfigFile(file, original) {
  assertUnchanged(file, original);
  rmSync(file);
}
