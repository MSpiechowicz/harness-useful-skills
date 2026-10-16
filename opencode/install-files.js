import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { ROLE_AGENTS, writeAtomic } from "../model-roles.js";
import { INSTALL_RECORD, directoryProblem, installRecordPath, lstatOrNull, scopeRootFor, toAbsolute, writeTargetProblem } from "./paths.js";

const ENTRY_FILE = "useful-skills.js";
const RUNTIME_DIRECTORY = "useful-skills";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
/** Runtime-tree folders that OpenCode only discovers from the scope root, so they are installed there too. */
const DISCOVERED = Object.freeze([["opencode/skills", "skills"], ["opencode/commands", "commands"]]);

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** `<scopeRoot>/agents/us-<agent>.md` for every generated agent. */
export const agentFiles = (scopeRoot) => Object.keys(ROLE_AGENTS).map((agent) => path.join(scopeRoot, "agents", `us-${agent}.md`));

/**
 * The directory OpenCode reads for a scope. User scope is the real path of the config directory (created on demand);
 * project scope is `<cwd>/.opencode`, which must be a real directory. Returns null when it does not exist and
 * `create` is false; throws on an unknown scope or a symlinked scope root.
 */
export function resolveScopeRoot({ scope = "user", cwd = process.cwd(), environment = process.env, create = false }) {
  const scopeRoot = scopeRootFor({ scope, cwd, environment });
  const stat = lstatOrNull(scopeRoot);
  if (scope === "user") {
    if (!stat && !create) return null;
    if (!stat) mkdirSync(scopeRoot, { recursive: true });
    return realpathSync(scopeRoot);
  }

  const resolved = path.join(realpathSync(path.dirname(scopeRoot)), path.basename(scopeRoot));
  if (stat && !stat.isDirectory()) throw new Error(`${scopeRoot} is not a real directory.`);
  if (!stat && !create) return null;
  if (!stat) mkdirSync(resolved);
  return resolved;
}

function readTree(directory, prefix, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) readTree(target, rel, files);
    else if (entry.isFile()) files.set(rel, readFileSync(target));
    else throw new Error(`The bundle contains ${target}, which is neither a regular file nor a directory.`);
  }
}

/**
 * Read an OpenCode plugin bundle: the plugin entry plus its runtime tree. Returns `{version, files}` where `files`
 * maps scope-root-relative paths to contents, including the skills and commands copied to where OpenCode discovers them.
 */
export function readBundle(bundleRoot) {
  const entry = path.join(bundleRoot, ENTRY_FILE);
  const runtimeRoot = path.join(bundleRoot, RUNTIME_DIRECTORY);
  if (!lstatOrNull(entry)?.isFile() || !lstatOrNull(runtimeRoot)?.isDirectory()) {
    throw new Error(`${bundleRoot} is not an OpenCode bundle (expected ${ENTRY_FILE} and ${RUNTIME_DIRECTORY}/).`);
  }

  const runtime = new Map();
  readTree(runtimeRoot, "", runtime);
  if (runtime.has(INSTALL_RECORD)) throw new Error(`The bundle must not contain ${INSTALL_RECORD}.`);

  let version;
  try {
    version = JSON.parse(runtime.get("package.json")?.toString("utf8") ?? "").version;
  } catch {
    version = undefined;
  }
  if (typeof version !== "string" || !STABLE_VERSION.test(version) || !runtime.has("opencode/mcp-server.js")) {
    throw new Error(`${runtimeRoot} is incomplete (needs package.json with a stable x.y.z version and opencode/mcp-server.js).`);
  }

  const files = new Map([[`plugins/${ENTRY_FILE}`, readFileSync(entry)]]);
  for (const [rel, data] of runtime) {
    files.set(`plugins/${RUNTIME_DIRECTORY}/${rel}`, data);
    for (const [from, to] of DISCOVERED) {
      if (rel.startsWith(`${from}/`)) files.set(`${to}/${rel.slice(from.length + 1)}`, data);
    }
  }
  for (const [, to] of DISCOVERED) {
    if (![...files.keys()].some((rel) => rel.startsWith(`${to}/`))) throw new Error(`The bundle has no ${to}.`);
  }
  return { version, files };
}

/** What is at `target`: `missing`, a regular `file` with its hash, or `other` (symlink, directory, device...). */
function inspect(target) {
  const stat = lstatOrNull(target);
  if (!stat) return { kind: "missing" };
  if (!stat.isFile()) return { kind: "other", what: stat.isSymbolicLink() ? "a symbolic link" : "not a regular file" };
  return { kind: "file", sha: sha256(readFileSync(target)) };
}

/** Whether `rel` is `ok` (a regular file matching the `recorded` hash), `modified`, `missing`, or `blocked` by a symlink or non-file. */
export function ownedState(scopeRoot, rel, recorded) {
  const problem = directoryProblem(scopeRoot, rel);
  if (problem) return { state: "blocked", detail: problem };
  const found = inspect(toAbsolute(scopeRoot, rel));
  if (found.kind === "missing") return { state: "missing" };
  if (found.kind === "other") return { state: "blocked", detail: `${toAbsolute(scopeRoot, rel)} is ${found.what}` };
  return { state: found.sha === recorded ? "ok" : "modified" };
}

/** One line saying why an installed file is left alone; files behind the same symlinked directory share one line. */
export function leftNote(scopeRoot, rel, { state, detail }) {
  return state === "blocked" ? detail : `${toAbsolute(scopeRoot, rel)} (modified since it was installed)`;
}

/** Decide, before touching anything, what installing `bundle` over a previous install (`previous`: rel -> sha256) does. */
export function planFiles(scopeRoot, bundle, previous) {
  // writes/unchanged: {rel, data?, sha}; stale: owned rels to delete; dropped: rels to forget; kept: left-in-place notes.
  const plan = { writes: [], unchanged: [], stale: [], dropped: [], kept: new Set(), problems: [] };

  for (const [rel, data] of bundle.files) {
    const target = toAbsolute(scopeRoot, rel);
    const sha = sha256(data);
    const blocked = directoryProblem(scopeRoot, rel);
    const found = blocked ? { kind: "other", what: blocked } : inspect(target);
    if (found.kind === "missing") plan.writes.push({ rel, data, sha });
    else if (found.kind === "other") plan.problems.push(`${target}: ${blocked ?? found.what}`);
    else if (found.sha === sha) plan.unchanged.push({ rel, sha });
    else if (previous[rel] === undefined) plan.problems.push(`${target}: exists but Useful Skills did not install it`);
    else if (previous[rel] !== found.sha) plan.problems.push(`${target}: modified since it was installed`);
    else plan.writes.push({ rel, data, sha });
  }

  for (const [rel, recorded] of Object.entries(previous)) {
    if (bundle.files.has(rel)) continue;
    const { state, detail } = ownedState(scopeRoot, rel, recorded);
    if (state === "ok") plan.stale.push(rel);
    else {
      plan.dropped.push(rel);
      if (state !== "missing") plan.kept.add(leftNote(scopeRoot, rel, { state, detail }));
    }
  }

  // Generated agents and the models file are written by the role sync; never let it follow a symlink.
  for (const target of [...agentFiles(scopeRoot), path.join(scopeRoot, "useful-skills", "models.yml")]) {
    const problem = writeTargetProblem(scopeRoot, path.relative(scopeRoot, target).split(path.sep).join("/"));
    if (problem) plan.problems.push(problem);
  }
  return plan;
}

/** Remove now-empty parent directories of `file`, stopping at (and never removing) `scopeRoot`. */
export function pruneEmptyDirectories(scopeRoot, file) {
  for (let directory = path.dirname(file); directory !== scopeRoot && directory.startsWith(scopeRoot); directory = path.dirname(directory)) {
    try {
      rmdirSync(directory);
    } catch {
      return;
    }
  }
}

/** Delete `rel` under `scopeRoot` and any directories that leaves empty. */
export function removeOwned(scopeRoot, rel) {
  const target = toAbsolute(scopeRoot, rel);
  rmSync(target);
  pruneEmptyDirectories(scopeRoot, target);
}

/** Write the planned files, then remove the stale ones; `record` (rel -> sha256) is kept in step so a failure leaves it truthful. */
export function applyPlan(scopeRoot, plan, record) {
  for (const { rel, sha } of plan.unchanged) record[rel] = sha;
  for (const rel of plan.dropped) delete record[rel];
  for (const { rel, data, sha } of plan.writes) {
    writeAtomic(toAbsolute(scopeRoot, rel), data);
    record[rel] = sha;
  }
  for (const rel of plan.stale) {
    removeOwned(scopeRoot, rel);
    delete record[rel];
  }
}

export const recordText = (record) => `${JSON.stringify(record, null, 2)}\n`;

/** The install record's regular-file path, after checking no directory above it is a symlink. */
export function checkedRecordPath(scopeRoot) {
  const file = installRecordPath(scopeRoot);
  const problem = directoryProblem(scopeRoot, path.relative(scopeRoot, file).split(path.sep).join("/"));
  if (problem) throw new Error(`${problem}.`);
  return file;
}
