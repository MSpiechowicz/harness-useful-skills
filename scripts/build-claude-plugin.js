#!/usr/bin/env node
// Builds plugins/claude: a Claude-only plugin bundle with the same relative layout as this repository.
// plugins/claude/README.md is hand-written and is the only file the generator never touches.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(root, 'plugins', 'claude');
const OUTPUT = 'plugins/claude';
const check = process.argv[2] === '--check';
if (process.argv.length > 3 || (process.argv[2] && !check)) {
  throw new Error('Usage: node scripts/build-claude-plugin.js [--check]');
}

const PRESERVED = new Set(['README.md']);

// Every file shipped to Claude. Skills are the only walked folders; nothing else is matched by pattern.
const FILES = [
  // Root runtime modules reached by importing claude/*.js (and the files they spawn or read).
  'doctor.js', 'resources.js', 'workflow-policy.js', 'workflow-settings.js', 'memory.js',
  'graphify.js', 'graph-safety.js', 'graph-storage.js', 'graph-validation.js',
  'graph-import-provenance.js', 'graph-import-provenance.py', 'graph-placeholder-imports.js',
  'graph-scope.js', 'graph-mounts.js', 'path-boundary.js', 'process.js',
  'setup-lock.js', 'setup-runner.js', 'setup-watchdog.js',
  'dependencies.js', 'dependency-policy.js', 'dependency-transport.js',
  // Claude adapter.
  'claude/command.js', 'claude/hooks.js', 'claude/mcp-server.js', 'claude/models.js',
  'claude/settings.js', 'claude/context.js', 'claude/host-context.js', 'claude/local-facts.js',
  'claude/doctor-setup.js',
  'claude/agents/backend.md', 'claude/agents/frontend.md', 'claude/agents/general-purpose.md',
  'claude/agents/planner.md', 'claude/agents/reviewer.md', 'claude/agents/scout.md',
  'claude/agents/security-reviewer.md',
  // Hook registration and the pinned dependency metadata Graphify setup verifies.
  'hooks/hooks.json', 'hooks/register.ts',
  'dependencies/manifest.json', 'dependencies/graphify.lock',
  // Licenses: claude/skills carries text derived from every upstream below, so all of them ship.
  'LICENSE',
  'licenses/caveman/LICENSE.txt', 'licenses/ecc/LICENSE.txt',
  'licenses/graphify/LICENSE-MIT.txt', 'licenses/graphify/LICENSE.txt', 'licenses/graphify/NOTICE.txt',
  'licenses/mattpocock-skills/LICENSE.txt', 'licenses/superpowers/LICENSE.txt',
  '.claude-plugin/icon.png',
];

/**
 * Lstats every component of a repository-relative directory path below the repository root.
 * A link or non-directory anywhere on the way is refused. Returns false when a component does not exist yet.
 */
function realDirectories(relative) {
  let current = root;
  for (const part of relative.split('/').filter(part => part && part !== '.')) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`${relative}: ${part} must be a real directory, not a link or file`);
  }
  return true;
}

/** A bundle source: a regular file whose parent directories are real. Links are refused, never followed. */
function readSource(path) {
  realDirectories(dirname(path));
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

function readJson(path) {
  return JSON.parse(readSource(path).toString('utf8'));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** True when `path` is a plain repository-relative POSIX path: no empty, '.', '..', or '.git' (any case) segment, no backslash or NUL, already normalized. */
function isPlainRelativePath(path) {
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) return false;
  return posix.normalize(path) === path;
}

/** True when `path` resolves strictly below `base` without any parent traversal. */
function isContained(base, path) {
  const inside = relative(base, path);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/** Refuses any bundle path that could leave the repository or the output root. */
function assertContained(path) {
  if (!isPlainRelativePath(path) || !isContained(root, join(root, path)) || !isContained(outputRoot, join(outputRoot, path))) {
    throw new Error(`Refusing unsafe bundle path: ${JSON.stringify(path)}`);
  }
}

/**
 * Writes through a new temporary file in the destination directory, then renames it over the destination.
 * An existing destination (including a hard link shared with a file elsewhere) is replaced, never written through.
 */
function replaceFile(destination, content) {
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

/** Files git tracks (index entries, including staged additions) below claude/skills, as repository-relative POSIX paths. */
function trackedSkillFiles() {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-z', '--', 'claude/skills'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`Cannot list tracked skill files with git ls-files: ${error.message}`);
  }
  const paths = listing.split('\0').filter(Boolean);
  for (const path of paths) assertContained(path);
  return paths;
}

/** The skill folders in marketplace order, verified against what is actually on disk. */
function skillNames() {
  const catalog = readJson('.claude-plugin/marketplace.json');
  const listed = catalog.plugins[0].skills.map(path => /^\.\/claude\/skills\/(us-[a-z-]+)\/$/.exec(path)?.[1]);
  const onDisk = readdirSync(join(root, 'claude', 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('us-'))
    .map(entry => entry.name);
  if (listed.includes(undefined) || [...listed].sort().join() !== onDisk.sort().join()) {
    throw new Error('claude/skills folders do not match .claude-plugin/marketplace.json');
  }
  return listed;
}

/** The root manifest plus the bundle's explicit skill list, keeping the root field order. */
function manifest(skills) {
  const generated = {};
  for (const [key, value] of Object.entries(readJson('.claude-plugin/plugin.json'))) {
    generated[key] = value;
    if (key === 'agents') generated.skills = skills.map(name => `./claude/skills/${name}/`);
  }
  if (!generated.homepage || !generated.skills) throw new Error('Root plugin manifest needs homepage and agents fields');
  return generated;
}

function expectedOutput() {
  const skills = skillNames();
  const tracked = trackedSkillFiles();
  // Skill folders ship only what git tracks, so untracked or ignored files never reach the bundle.
  const skillFiles = skills.flatMap(name => {
    const files = tracked.filter(path => path.startsWith(`claude/skills/${name}/`));
    if (!files.includes(`claude/skills/${name}/SKILL.md`)) throw new Error(`claude/skills/${name}/SKILL.md is not tracked by git`);
    return files;
  });
  const output = new Map();
  for (const path of [...FILES, ...skillFiles]) {
    assertContained(path);
    output.set(path, readSource(path));
  }
  output.set('.claude-plugin/plugin.json', Buffer.from(json(manifest(skills))));
  output.set('package.json', Buffer.from(json({ name: 'useful-skills-claude', private: true, type: 'module' })));
  return output;
}

/** Everything below the output root by directory-entry type (readdir does not follow links), so links are reported as 'other'. */
function existing(directory = outputRoot, prefix = '') {
  const found = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.set(path, 'directory');
      for (const [child, type] of existing(join(directory, entry.name), path)) found.set(child, type);
    } else {
      found.set(path, entry.isFile() ? 'file' : 'other');
    }
  }
  return found;
}

/**
 * True when the output root exists. Every component from the repository root (plugins, plugins/claude) must be a real
 * directory, and its resolved path must be exactly <real repository root>/plugins/claude, before anything is read or written.
 */
function outputExists() {
  if (!realDirectories(OUTPUT)) return false;
  if (realpathSync(outputRoot) !== join(realpathSync(root), 'plugins', 'claude')) {
    throw new Error(`${OUTPUT} resolves outside the repository`);
  }
  return true;
}

function differences(output, found) {
  const missing = [];
  const stale = [];
  for (const [path, content] of output) {
    if (found.get(path) !== 'file') {
      missing.push(path);
    } else if (!readFileSync(join(outputRoot, path)).equals(content)) {
      stale.push(path);
    }
  }
  const extra = [...found].filter(([path, type]) => type !== 'directory' && !output.has(path) && !PRESERVED.has(path));
  return { missing, stale, extra: extra.map(([path]) => path), readme: found.get('README.md') === 'file' };
}

function main() {
  const output = expectedOutput();
  const found = outputExists() ? existing() : new Map();
  const { missing, stale, extra, readme } = differences(output, found);

  if (check) {
    if (!readme) missing.push('README.md');
    const problems = [
      ...missing.map(path => `missing: ${path}`),
      ...stale.map(path => `stale: ${path}`),
      ...extra.map(path => `extra: ${path}`),
    ];
    if (problems.length > 0) {
      console.error(`plugins/claude is out of sync:\n${problems.join('\n')}\nRun node scripts/build-claude-plugin.js`);
      process.exitCode = 1;
    } else {
      console.log(`Checked ${output.size} Claude plugin bundle files`);
    }
  } else {
    // Extras go first: a link or file in the way of a directory is removed without being followed.
    for (const path of extra) rmSync(join(outputRoot, path), { force: true });
    for (const [path, type] of [...found].reverse()) {
      if (type === 'directory' && ![...output.keys()].some(file => file.startsWith(`${path}/`))) {
        rmSync(join(outputRoot, path), { recursive: true, force: true });
      }
    }
    for (const [path, content] of output) {
      if (!missing.includes(path) && !stale.includes(path)) continue;
      const destination = join(outputRoot, path);
      // A link or directory where a file belongs is removed first; an existing file is replaced by rename, never written through.
      if (found.get(path) && found.get(path) !== 'file') rmSync(destination, { recursive: true, force: true });
      mkdirSync(dirname(destination), { recursive: true });
      replaceFile(destination, content);
    }
    console.log(`Built ${output.size} Claude plugin bundle files in plugins/claude`);
    if (!readme) console.warn('plugins/claude/README.md is missing; it is hand-written and not generated');
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
