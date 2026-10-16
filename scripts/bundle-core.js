// Shared mechanics for the generated plugin bundles (plugins/claude, plugins/opencode).
// A bundle is a map of repository-relative output paths to file contents, written below `<root>/<output>`.
// Nothing here knows what a particular bundle ships: builders pick the files and call syncBundle.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isPlainRelativePath } from '../path-boundary.js';

/** True when `path` resolves strictly below `base` without any parent traversal. */
export function isContained(base, path) {
  const inside = relative(base, path);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * Lstats every component of a repository-relative directory path below `root`.
 * A link or non-directory anywhere on the way is refused. Returns false when a component does not exist yet.
 */
export function realDirectories(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/').filter(part => part && part !== '.')) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`${relativePath}: ${part} must be a real directory, not a link or file`);
  }
  return true;
}

/** A bundle source: a regular file whose parent directories are real. Links are refused, never followed. */
export function readSource(root, path) {
  realDirectories(root, dirname(path));
  let stat;
  try {
    stat = lstatSync(join(root, path));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Bundle source is missing: ${path}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Bundle source must be a regular file, not a link or special file: ${path}`);
  return readFileSync(join(root, path));
}

/** Refuses any bundle path that could leave the repository or the output directory (`output` is relative to `root`). */
export function assertContained(root, output, path) {
  if (!isPlainRelativePath(path) || !isContained(root, join(root, path)) || !isContained(join(root, output), join(root, output, path))) {
    throw new Error(`Refusing unsafe bundle path: ${JSON.stringify(path)}`);
  }
}

/**
 * Writes through a new temporary file in the destination directory, then renames it over the destination.
 * An existing destination (including a hard link shared with a file elsewhere) is replaced, never written through.
 */
export function replaceFile(destination, content) {
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Keep the original failure; a leftover temporary file is less important than why the write failed.
    }

    throw error;
  }
}

/** Files git tracks (index entries, including staged additions) below `prefix`, as repository-relative POSIX paths. */
export function trackedFiles(root, output, prefix) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`Cannot list tracked files below ${prefix} with git ls-files: ${error.message}`);
  }
  const paths = listing.split('\0').filter(Boolean);
  for (const path of paths) assertContained(root, output, path);
  return paths;
}

/**
 * The expected bundle: `sources` are repository-relative files copied byte for byte; `generated` are `{path, content}`
 * entries (string or Buffer) that exist only in the bundle. A generated path wins over a source with the same path.
 */
export function collectOutput({ root, output, sources = [], generated = [] }) {
  const files = new Map();
  for (const path of sources) {
    assertContained(root, output, path);
    files.set(path, readSource(root, path));
  }
  for (const { path, content } of generated) {
    assertContained(root, output, path);
    files.set(path, Buffer.from(content));
  }
  return files;
}

const inTree = (path, trees) => trees.some(tree => path.startsWith(`${tree}/`));

/**
 * Everything below the output directory by directory-entry type (readdir does not follow links), so links are reported as 'other'.
 * A file with any execute bit below a preserved tree is also 'other': hand-written trees may hold data, not runnable files.
 */
export function existing(outputRoot, trees = [], directory = outputRoot, prefix = '') {
  const found = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.set(path, 'directory');
      for (const [child, type] of existing(outputRoot, trees, join(directory, entry.name), path)) found.set(child, type);
    } else {
      const executable = entry.isFile() && inTree(path, trees) && (lstatSync(join(directory, entry.name)).mode & 0o111) !== 0;
      found.set(path, entry.isFile() && !executable ? 'file' : 'other');
    }
  }
  return found;
}

/**
 * True when the output directory exists. Every component from the repository root must be a real directory,
 * and its resolved path must be exactly <real repository root>/<output>, before anything is read or written.
 */
export function outputExists(root, output) {
  if (!realDirectories(root, output)) return false;
  if (realpathSync(join(root, output)) !== join(realpathSync(root), output)) {
    throw new Error(`${output} resolves outside the repository`);
  }
  return true;
}

/**
 * Compares the expected map with what exists. `preserved` is `{files, trees}`: hand-written names that are never extras.
 * Only real files and directories below a preserved tree are kept; links and executables there are extras.
 */
export function differences(expected, found, outputRoot, { files = [], trees = [] } = {}) {
  const missing = [];
  const stale = [];
  for (const [path, content] of expected) {
    if (found.get(path) !== 'file') {
      missing.push(path);
    } else if (!readFileSync(join(outputRoot, path)).equals(content)) {
      stale.push(path);
    }
  }
  const kept = (path, type) => files.includes(path) || (inTree(path, trees) && (type === 'directory' || type === 'file'));
  const extra = [...found].filter(([path, type]) => type !== 'directory' && !expected.has(path) && !kept(path, type));
  return { missing, stale, extra: extra.map(([path]) => path) };
}

/**
 * Brings `<root>/<output>` in line with `expected`, or with `check` reports how it differs (exit code 1).
 * `preserved.required` lists preserved files that must exist; their absence is reported, and only warned about when building.
 * `label` names the bundle in messages (for example "Claude plugin"); `command` is what to run to regenerate it.
 */
export function syncBundle({ root, output, expected, check, label, command, preserved = {} }) {
  const outputRoot = join(root, output);
  const { files = [], trees = [], required = [] } = preserved;
  const found = outputExists(root, output) ? existing(outputRoot, trees) : new Map();
  const { missing, stale, extra } = differences(expected, found, outputRoot, preserved);
  const absent = required.filter(path => found.get(path) !== 'file');

  if (check) {
    const problems = [
      ...[...missing, ...absent].map(path => `missing: ${path}`),
      ...stale.map(path => `stale: ${path}`),
      ...extra.map(path => `extra: ${path}`),
    ];
    if (problems.length > 0) {
      console.error(`${output} is out of sync:\n${problems.join('\n')}\nRun ${command}`);
      process.exitCode = 1;
    } else {
      console.log(`Checked ${expected.size} ${label} bundle files`);
    }
    return;
  }

  // Extras go first: a link or file in the way of a directory is removed without being followed.
  for (const path of extra) rmSync(join(outputRoot, path), { force: true });
  for (const [path, type] of [...found].reverse()) {
    const kept = trees.includes(path) || inTree(path, trees);
    if (type === 'directory' && !kept && ![...expected.keys()].some(file => file.startsWith(`${path}/`))) {
      rmSync(join(outputRoot, path), { recursive: true, force: true });
    }
  }
  for (const [path, content] of expected) {
    if (!missing.includes(path) && !stale.includes(path)) continue;
    const destination = join(outputRoot, path);
    // A link or directory where a file belongs is removed first; an existing file is replaced by rename, never written through.
    if (found.get(path) && found.get(path) !== 'file') rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    replaceFile(destination, content);
  }
  console.log(`Built ${expected.size} ${label} bundle files in ${output}`);
  for (const path of absent) console.warn(`${output}/${path} is missing; it is hand-written and not generated`);
}
