/**
 * Where Useful Skills for OpenCode lives on disk. Every function is synchronous and has no side effects
 * beyond reading files, so installers, the plugin runtime, and hook subprocesses resolve the same paths.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPlainRelativePath } from "../path-boundary.js";

/** The runtime tree this module runs from: the parent of `opencode/` (the checkout root, or an installed runtime tree). */
export const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const INSTALL_RECORD = "install-record.json";

const RECORD_MAX_BYTES = 1024 * 1024;
const SCOPES = Object.freeze(["user", "project"]);
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const NOT_INSTALLED = "Useful Skills is not installed for OpenCode from this runtime; run `./useful-skills install --host opencode` from a Useful Skills checkout.";

function homeDirectory(environment) {
  return environment.HOME && path.isAbsolute(environment.HOME) ? environment.HOME : os.homedir();
}

/** An absolute XDG base directory from the environment, else `<home>/<fallback>`. */
function xdgBase(environment, variable, fallback) {
  const value = environment[variable];
  return value && path.isAbsolute(value) ? value : path.join(homeDirectory(environment), fallback);
}

/** OpenCode's user config dir. OPENCODE_CONFIG_DIR is deliberately ignored: it adds a config source, not an install target. */
export function opencodeConfigDir(environment = process.env) {
  return path.join(xdgBase(environment, "XDG_CONFIG_HOME", ".config"), "opencode");
}

export function defaultDataDir(environment = process.env) {
  return path.join(xdgBase(environment, "XDG_DATA_HOME", path.join(".local", "share")), "opencode", "useful-skills");
}

/** The install root for a scope, without resolving links or creating anything. */
export function scopeRootFor({ scope = "user", cwd = process.cwd(), environment = process.env } = {}) {
  if (scope === "user") {
    return opencodeConfigDir(environment);
  }

  if (scope === "project") {
    return path.join(path.resolve(cwd), ".opencode");
  }

  throw new Error("--scope must be user or project.");
}

export function installRecordPath(scopeRoot) {
  return path.join(scopeRoot, "plugins", "useful-skills", INSTALL_RECORD);
}

/**
 * Text that is safe to print to a terminal: every control character (C0, DEL, C1 such as the 8-bit CSI) becomes a
 * space, except newlines, which keep multi-line messages intact. Anything read from disk or the environment is untrusted.
 */
export const printableText = (text) => String(text).replace(CONTROL_CHARACTERS, " ");

export const lstatOrNull = (target) => lstatSync(target, { throwIfNoEntry: false }) ?? null;
export const toAbsolute = (scopeRoot, rel) => path.join(scopeRoot, ...rel.split("/"));

/** The first directory in `rel`'s chain (everything but its last component) under `scopeRoot` that is a symlink or not a directory. */
export function directoryProblem(scopeRoot, rel) {
  const parts = rel.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const directory = toAbsolute(scopeRoot, parts.slice(0, depth).join("/"));
    const stat = lstatOrNull(directory);
    if (!stat) return undefined;
    if (!stat.isDirectory()) return `${directory} is ${stat.isSymbolicLink() ? "a symbolic link" : "not a directory"}`;
  }
  return undefined;
}

/**
 * Why Useful Skills must not write `<scopeRoot>/<rel>`: a symlinked or non-directory component under the scope root, or
 * an existing target that is not a regular file. The check and the later write are separate steps, so a concurrent
 * writer that swaps a component in between is out of scope (the same trust boundary as the scope root's owner).
 */
export function writeTargetProblem(scopeRoot, rel) {
  const problem = directoryProblem(scopeRoot, rel);
  if (problem) return problem;
  const target = toAbsolute(scopeRoot, rel);
  const stat = lstatOrNull(target);
  if (stat && !stat.isFile()) return `${target} is ${stat.isSymbolicLink() ? "a symbolic link" : "not a regular file"}`;
  return undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value);
}

/** Whether no string in `value` (keys included) holds a control character. */
export function isPrintable(value) {
  if (typeof value === "string") return !CONTROL_CHARACTER.test(value);
  if (Array.isArray(value)) return value.every(isPrintable);
  if (isRecord(value)) return Object.entries(value).every(([key, item]) => isPrintable(key) && isPrintable(item));
  return true;
}

function validRecord(record) {
  if (!isRecord(record) || record.schema !== 1 || typeof record.version !== "string" || !STABLE_VERSION.test(record.version) || !SCOPES.includes(record.scope)) {
    return false;
  }

  if (!isAbsolutePath(record.scopeRoot) || !isAbsolutePath(record.dataDir)) {
    return false;
  }

  if (record.configFile !== null && !isAbsolutePath(record.configFile)) {
    return false;
  }

  if (record.mcpEntry !== null && !isRecord(record.mcpEntry)) {
    return false;
  }

  if (record.configCreated !== undefined && typeof record.configCreated !== "boolean") {
    return false;
  }

  if (!isRecord(record.files)) {
    return false;
  }

  // The record is printed by status and uninstall output, so a crafted one must not smuggle terminal escapes in.
  if (!isPrintable([record.scopeRoot, record.dataDir, record.configFile, record.mcpEntry, record.files])) {
    return false;
  }

  return Object.entries(record.files).every(([file, digest]) => isPlainRelativePath(file) && typeof digest === "string" && SHA256.test(digest));
}

/**
 * Read an install record without following a symbolic link or blocking on a FIFO. Returns null when the
 * file does not exist and throws when it is not a small regular file holding a valid record.
 */
export function readInstallRecord(file) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw new Error(error?.code === "ELOOP" ? "The OpenCode install record must not be a symbolic link." : "Cannot read the OpenCode install record.");
  }

  let text;
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) {
      throw new Error("The OpenCode install record must be a regular file.");
    }

    if (details.size > RECORD_MAX_BYTES) {
      throw new Error("The OpenCode install record is too large.");
    }

    text = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error("The OpenCode install record is not valid JSON.");
  }

  if (!validRecord(record)) {
    throw new Error("The OpenCode install record has an unexpected format.");
  }

  return record;
}

/**
 * The install that owns the runtime tree at `runtimeRoot` (`<scopeRoot>/plugins/useful-skills`), or null when
 * this runtime is not an installed tree (such as a checkout) or has no record. Throws on an untrustworthy record.
 */
export function runtimeInstall(runtimeRoot = RUNTIME_ROOT) {
  let root;
  try {
    root = realpathSync(runtimeRoot);
  } catch {
    return null;
  }

  const pluginsDir = path.dirname(root);
  if (path.basename(root) !== "useful-skills" || path.basename(pluginsDir) !== "plugins") {
    return null;
  }

  const scopeRoot = path.dirname(pluginsDir);
  const record = readInstallRecord(installRecordPath(scopeRoot));
  if (!record) {
    return null;
  }

  let recordedRoot;
  try {
    recordedRoot = realpathSync(record.scopeRoot);
  } catch {
    recordedRoot = undefined;
  }

  if (recordedRoot !== scopeRoot) {
    throw new Error("The OpenCode install record belongs to a different location.");
  }

  return { scopeRoot, record };
}

/**
 * The private data directory: an absolute USEFUL_SKILLS_DATA wins (tests and custom setups), then the
 * install record of this runtime. Returns the path, or `{ reason }` when it cannot be located safely.
 */
export function resolveDataDir({ environment = process.env, runtimeRoot = RUNTIME_ROOT } = {}) {
  const override = environment.USEFUL_SKILLS_DATA;
  if (override !== undefined && override !== "") {
    return path.isAbsolute(override) ? override : { reason: "USEFUL_SKILLS_DATA must be an absolute path." };
  }

  let installed;
  try {
    installed = runtimeInstall(runtimeRoot);
  } catch (error) {
    return { reason: error.message };
  }

  return installed ? installed.record.dataDir : { reason: NOT_INSTALLED };
}

function packageVersion(file) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }

  return isRecord(manifest) && manifest.name === "useful-skills-opencode" && typeof manifest.version === "string" ? manifest.version : undefined;
}

/**
 * The version of the OpenCode runtime: an installed runtime tree carries the OpenCode package manifest at its root,
 * a checkout keeps it at `opencode/package.json`. Throws when neither exists.
 */
export function bundleVersion(runtimeRoot = RUNTIME_ROOT) {
  const version = packageVersion(path.join(runtimeRoot, "package.json")) ?? packageVersion(path.join(runtimeRoot, "opencode", "package.json"));
  if (!version) {
    throw new Error("Cannot read the Useful Skills OpenCode package version.");
  }

  return version;
}
