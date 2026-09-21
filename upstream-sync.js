import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const UPSTREAM_REPOSITORY = "affaan-m/ECC";
export const UPSTREAM_URL = "https://github.com/affaan-m/ECC.git";
const INITIAL_REVISION = "934195f955cf0da847d59fcd6f68856bce112d8b";
const MANIFEST = "ecc-upstream.json";
const ROOTS = ["agents", "commands", "rules", "skills"];
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const REF = /^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;
const SHA = /^[0-9a-f]{40}$/;
const FOREIGN_HARNESS = /\b(?:claude(?:[-_ ]code)?|CLAUDE_[A-Z_]+|\.claude|cursor|codex)\b/i;

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamError";
  }
}

function fail(message) {
  throw new UpstreamError(message);
}

function validRef(ref) {
  return typeof ref === "string" && ref.length <= 200 && REF.test(ref)
    && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".");
}

function isRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length < 500
    && !value.includes("\\") && !value.startsWith("/") && !value.includes("\0")
    && path.posix.normalize(value) === value && !value.split("/").includes("..");
}

function isExcluded(relative, excluded) {
  return excluded.some((entry) => entry.endsWith("/") ? relative.startsWith(entry) : relative === entry);
}

function allowedPath(relative, excluded) {
  const root = relative.split("/", 1)[0];
  return ROOTS.includes(root) && relative.toLowerCase().endsWith(".md") && !isExcluded(relative, excluded);
}

async function defaultRunner(file, args, options) {
  const { stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? TIMEOUT_MS,
    maxBuffer: MAX_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  });
  return String(stdout);
}

function normalizedOptions(options = {}) {
  if (!options || typeof options !== "object") fail("Upstream options must be an object.");
  const root = path.resolve(options.root ?? PACKAGE_ROOT);
  const ref = options.ref ?? "main";
  if (!validRef(ref)) fail("Upstream ref must be a safe branch, tag, or 40-character commit SHA.");
  if (options.runner !== undefined && typeof options.runner !== "function") fail("Upstream runner must be a function.");
  if (options.upstreamUrl !== undefined && (typeof options.upstreamUrl !== "string" || !path.isAbsolute(options.upstreamUrl))) {
    fail("upstreamUrl is reserved for an absolute local Git fixture path.");
  }
  return { root, ref, runner: options.runner ?? defaultRunner, upstreamUrl: options.upstreamUrl };
}

async function git(state, args, cwd, allowFailure = false) {
  try {
    const stdout = await state.runner("git", args, { cwd, timeoutMs: TIMEOUT_MS });
    if (typeof stdout !== "string") fail("Upstream runner did not return stdout.");
    return { stdout, code: 0 };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : -1;
    if (allowFailure) return { stdout: String(error?.stdout ?? ""), code };
    const detail = String(error?.stderr ?? error?.message ?? "Git command failed.").trim();
    fail(`Upstream Git operation failed: ${detail.slice(0, 500)}`);
  }
}

async function loadManifest(root) {
  let data;
  try {
    data = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8"));
  } catch (error) {
    fail(`Cannot read ${MANIFEST}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!data || data.repository !== UPSTREAM_REPOSITORY || !SHA.test(data.revision) || !Array.isArray(data.excludedPaths)
    || !data.excludedPaths.every(isRelative)) {
    fail(`${MANIFEST} must declare the ECC repository, a 40-character revision, and safe excluded paths.`);
  }
  return data;
}

async function fixtureUrl(value) {
  if (!value) return UPSTREAM_URL;
  try {
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("upstreamUrl fixture must be a real local Git directory.");
    return await realpath(value);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    fail(`Cannot use upstreamUrl fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function makeRepository(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ecc-upstream-"));
  const upstreamUrl = await fixtureUrl(state.upstreamUrl);
  await git(state, ["init", "--quiet", directory], directory);
  await git(state, ["remote", "add", "origin", upstreamUrl], directory);
  await git(state, ["fetch", "--quiet", "--depth=1", "origin", state.ref], directory);
  const targetRevision = (await git(state, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], directory)).stdout.trim();
  if (!SHA.test(targetRevision)) fail("Upstream ref did not resolve to a commit.");
  return { directory, targetRevision };
}

function parseTree(output, excluded) {
  const entries = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, tab).split(" ");
    const relative = record.slice(tab + 1);
    if (!isRelative(relative)) fail(`Upstream tree contains an unsafe path: ${relative}`);
    if (!ROOTS.includes(relative.split("/", 1)[0])) continue;
    if (mode === "120000") fail(`Upstream tree contains a symlink in a managed root: ${relative}`);
    if (mode === "100644" && type === "blob" && allowedPath(relative, excluded)) entries.set(relative, object);
  }
  return entries;
}

async function tree(state, directory, revision, excluded) {
  const { stdout } = await git(state, ["ls-tree", "-r", "-z", "--full-tree", revision, "--", ...ROOTS], directory);
  return parseTree(stdout, excluded);
}

async function blob(state, directory, revision, relative) {
  return Buffer.from((await git(state, ["show", `${revision}:${relative}`], directory)).stdout, "utf8");
}

async function safeLocalFile(root, relative) {
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(`Refusing symlink or non-directory parent: ${relative}`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  const destination = path.join(root, relative);
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile()) fail(`Refusing symlink or non-file destination: ${relative}`);
    return await readFile(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function merge(state, base, local, target, temp) {
  const baseFile = path.join(temp, "base.md");
  const localFile = path.join(temp, "local.md");
  const targetFile = path.join(temp, "target.md");
  await Promise.all([writeFile(baseFile, base), writeFile(localFile, local), writeFile(targetFile, target)]);
  const result = await git(state, ["merge-file", "-p", localFile, baseFile, targetFile], temp, true);
  return result.code === 0 ? { content: Buffer.from(result.stdout), conflict: false } : { content: null, conflict: true };
}

function changedPaths(base, target) {
  const paths = new Set([...base.keys(), ...target.keys()]);
  return [...paths].filter((relative) => base.get(relative) !== target.get(relative)).sort();
}

async function planSync(state, repository, manifest, base, target, temporary) {
  const changes = changedPaths(base, target);
  const conflicts = [];
  const operations = [];
  for (const relative of changes) {
    const [baseObject, targetObject] = [base.get(relative), target.get(relative)];
    const local = await safeLocalFile(state.root, relative);
    if (!baseObject) {
      if (local) conflicts.push({ path: relative, reason: "add/add" });
      else operations.push({ path: relative, type: "write", content: await blob(state, repository, manifest.revision, relative).catch(() => null) });
      continue;
    }
    const baseContent = await blob(state, repository, manifest.revision, relative);
    if (!targetObject) {
      if (local && !local.equals(baseContent)) conflicts.push({ path: relative, reason: "delete/modify" });
      else if (local) operations.push({ path: relative, type: "delete" });
      continue;
    }
    const targetContent = await blob(state, repository, temporary.targetRevision, relative);
    if (!local) {
      conflicts.push({ path: relative, reason: "delete/modify" });
    } else if (local.equals(baseContent)) {
      operations.push({ path: relative, type: "write", content: targetContent });
    } else {
      const result = await merge(state, baseContent, local, targetContent, temporary.directory);
      if (result.conflict) conflicts.push({ path: relative, reason: "content conflict" });
      else operations.push({ path: relative, type: "write", content: result.content });
    }
  }
  return { changes, conflicts, operations };
}

async function packageVersion(state, repository, revision) {
  const result = await git(state, ["show", `${revision}:package.json`], repository, true);
  if (result.code !== 0) return null;
  try {
    return typeof JSON.parse(result.stdout).version === "string" ? JSON.parse(result.stdout).version : null;
  } catch {
    return null;
  }
}

async function warningsFor(state, repository, temporary, manifest, changes, target) {
  const warnings = [];
  for (const relative of changes) {
    if (!relative.toLowerCase().endsWith(".md") || !target.has(relative)) continue;
    const contents = (await blob(state, repository, temporary.targetRevision, relative)).toString("utf8");
    if (FOREIGN_HARNESS.test(contents)) warnings.push(`${relative}: contains foreign harness references.`);
    for (const match of contents.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      const link = match[1].split("#", 1)[0];
      if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) continue;
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
      if (!isRelative(destination) || (!target.has(destination) && !isExcluded(destination, manifest.excludedPaths))) {
        warnings.push(`${relative}: missing relative link ${link}.`);
      }
    }
  }
  return warnings;
}

async function sourceCheckout(root, state) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("Sync requires a real package-root directory.");
  const top = (await git(state, ["rev-parse", "--show-toplevel"], root)).stdout.trim();
  if (await realpath(root) !== await realpath(top)) fail("Sync requires the package root to be the Git worktree top-level.");
  const status = (await git(state, ["status", "--porcelain=v1", "--untracked-files=all"], root)).stdout;
  if (status) fail("Sync requires a clean Git worktree, including untracked files.");
}

async function createParent(root, relative, created) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(`Refusing symlink or non-directory parent: ${relative}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
      created.push(current);
    }
  }
}

async function apply(root, operations, manifest) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ecc-upstream-apply-"));
  const created = [];
  const backups = [];
  try {
    const staged = path.join(temporary, "staged");
    await mkdir(staged);
    for (const operation of operations) {
      if (operation.type !== "write") continue;
      const file = path.join(staged, operation.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, operation.content);
    }
    const manifestFile = path.join(staged, MANIFEST);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const actions = [...operations, { path: MANIFEST, type: "write", staged: manifestFile }];
    for (const action of actions) {
      await createParent(root, action.path, created);
      const destination = path.join(root, action.path);
      const backup = path.join(temporary, "backup", String(backups.length));
      try {
        await mkdir(path.dirname(backup), { recursive: true });
        await rename(destination, backup);
        backups.push({ destination, backup });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (action.type === "write") await rename(action.staged ?? path.join(staged, action.path), destination);
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      await rm(backup.destination, { force: true }).catch(() => {});
      await rename(backup.backup, backup.destination).catch(() => {});
    }
    for (const directory of created.reverse()) await rmdir(directory).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function message(report) {
  const target = report.targetRevision ? report.targetRevision.slice(0, 12) : "unresolved";
  const paths = report.changes.length ? ` ${report.changes.slice(0, 8).join(", ")}${report.changes.length > 8 ? ", …" : ""}` : "";
  if (report.conflicts.length) return `ECC ${target}: ${report.changes.length} upstream Markdown changes; ${report.conflicts.length} conflicts prevent sync.${paths}`;
  return `ECC ${target}: ${report.changes.length} upstream Markdown changes${report.applied ? " synchronized" : " available"}.${paths}`;
}

/** Check or three-way synchronize only ECC Markdown resources from a source checkout. */
export async function runUpstream(action, options = {}) {
  if (action !== "check" && action !== "sync") fail("Upstream action must be check or sync.");
  const state = normalizedOptions(options);
  const manifest = await loadManifest(state.root);
  if (manifest.revision !== INITIAL_REVISION && !SHA.test(manifest.revision)) fail("ECC provenance revision is invalid.");
  if (action === "sync") await sourceCheckout(state.root, state);
  const temporary = await makeRepository(state);
  try {
    await git(state, ["fetch", "--quiet", "--depth=1", "origin", manifest.revision], temporary.directory);
    const [base, target] = await Promise.all([
      tree(state, temporary.directory, manifest.revision, manifest.excludedPaths),
      tree(state, temporary.directory, temporary.targetRevision, manifest.excludedPaths),
    ]);
    const plan = await planSync(state, temporary.directory, manifest, base, target, temporary);
    const report = {
      baseRevision: manifest.revision,
      targetRevision: temporary.targetRevision,
      packageVersion: await packageVersion(state, temporary.directory, temporary.targetRevision),
      changes: plan.changes,
      conflicts: plan.conflicts,
      warnings: await warningsFor(state, temporary.directory, temporary, manifest, plan.changes, target),
      applied: false,
    };
    if (action === "sync" && !report.conflicts.length) {
      await apply(state.root, plan.operations, { ...manifest, revision: report.targetRevision });
      report.applied = true;
    }
    report.message = message(report);
    return report;
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
}
