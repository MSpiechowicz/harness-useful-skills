#!/usr/bin/env node
// Builds the two Codex bundles:
//   plugins/codex: the Codex plugin (manifest + skills) that a Codex marketplace installs.
//   plugins/codex-runtime/harness-useful-skills: the files the installer copies to <CODEX_HOME>/harness-useful-skills (memory server + agent files).
// plugins/codex/README.md is hand-written; the generator never touches it.
import { readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOutput, readSource, syncBundle } from './bundle-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'plugins/codex';
const RUNTIME = 'plugins/codex-runtime/harness-useful-skills';
const check = process.argv[2] === '--check';
if (process.argv.length > 3 || (process.argv[2] && !check)) {
  throw new Error('Usage: node scripts/build-codex-plugin.js [--check]');
}

const AGENT_ROLES = ['planner', 'scout', 'frontend', 'backend', 'general-purpose', 'reviewer', 'security-reviewer', 'release-assessor'];

// Licenses: codex/skills carries text derived from every upstream below, so all of them ship with the plugin and the runtime.
const LICENSES = [
  'LICENSE',
  'licenses/caveman/LICENSE.txt', 'licenses/ecc/LICENSE.txt',
  'licenses/mattpocock-skills/LICENSE.txt', 'licenses/superpowers/LICENSE.txt',
];

// The runtime file closure of codex/mcp-server.js; assertImportClosure below keeps this list honest.
// Nothing from claude/ or omp/ belongs here, and from opencode/ only the install helpers apply-models.js shares with the installer.
const RUNTIME_FILES = [
  'codex/mcp-server.js', 'codex/host-context.js',
  // The model roles: apply-models.js runs from the installed runtime (Codex has no session hook), and shares the installer's file helpers.
  'codex/apply-models.js', 'codex/models.js', 'codex/paths.js', 'codex/agents.js',
  'opencode/paths.js', 'opencode/install-files.js', 'model-roles.js', 'entrypoint.js',
  'mcp-memory-server.js', 'command-core.js', 'host-roots.js', 'local-facts.js', 'memory.js',
  'names.js', 'legacy-names.js', 'data-migration.js',
  'workflow-policy.js', 'workflow-settings.js', 'doctor.js', 'resources.js', 'process.js', 'path-boundary.js',
  'memory-paths.js', 'graphify-retirement.js',
  // The code-graph hint hook that hooks.json points at.
  'codex/hooks.js', 'codex/hook-input.js', 'code-hint.js', 'doctor-setup.js',
  ...AGENT_ROLES.map(role => `codex/agents/${role}.toml`),
  ...LICENSES,
];

/** Regular files below a repository-relative directory (links are refused), as repository-relative POSIX paths. */
function walk(directory) {
  const found = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`${path} must be a regular file or directory`);
  }
  return found;
}

/** The files below codex/skills, verified against the canonical skills/us-* set. */
function skillFiles() {
  const canonical = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('us-'))
    .map(entry => entry.name)
    .sort();
  const files = walk('codex/skills');
  const names = [...new Set(files.map(path => path.split('/')[2]))].sort();
  if (names.join() !== canonical.join()) {
    throw new Error(`codex/skills folders (${names.join(', ')}) do not match the canonical skills/us-* set (${canonical.join(', ')})`);
  }
  for (const name of names) {
    if (!files.includes(`codex/skills/${name}/SKILL.md`)) throw new Error(`codex/skills/${name}/SKILL.md is missing`);
  }
  return files;
}

const REFERENCE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']|new URL\(\s*["'](\.?\.?\/?[^"':]+)["']\s*,\s*import\.meta\.url/g;

/** Throws when a bundled module imports (or resolves by URL) a relative file that the bundle does not contain. */
function assertImportClosure(files) {
  const missing = [];
  for (const [path, content] of files) {
    if (!path.endsWith('.js')) continue;
    for (const match of content.toString('utf8').matchAll(REFERENCE)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1] ?? match[2]));
      if (!files.has(target)) missing.push(`${path} -> ${match[1] ?? match[2]}`);
    }
  }
  if (missing.length > 0) throw new Error(`The Codex runtime misses files that bundled modules import:\n${missing.join('\n')}`);
}

/** Source path -> bundle path for the plugin: the manifest moves into .codex-plugin and the skills drop their codex/ prefix. */
function pluginPath(source) {
  if (source === 'codex/plugin.json') return '.codex-plugin/plugin.json';
  return source.replace(/^codex\//, '');
}

function pluginOutput() {
  const manifest = JSON.parse(readSource(root, 'codex/plugin.json').toString('utf8'));
  const version = JSON.parse(readSource(root, 'package.json').toString('utf8')).version;
  if (manifest.version !== version) throw new Error(`codex/plugin.json version ${manifest.version} does not match package.json ${version}`);
  const sources = ['codex/plugin.json', ...skillFiles(), ...LICENSES];
  return collectOutput({ root, output: PLUGIN, generated: sources.map(source => ({ path: pluginPath(source), content: readSource(root, source) })) });
}

function runtimeOutput() {
  const generated = RUNTIME_FILES.map(source => ({ path: source, content: readSource(root, source) }));
  generated.push({ path: 'package.json', content: `${JSON.stringify({ name: 'harness-useful-skills-codex-runtime', private: true, type: 'module' }, null, 2)}\n` });
  const files = collectOutput({ root, output: RUNTIME, generated });
  assertImportClosure(files);
  return files;
}

try {
  syncBundle({
    root, output: PLUGIN, expected: pluginOutput(), check,
    label: 'Codex plugin', command: 'node scripts/build-codex-plugin.js',
    preserved: { files: ['README.md'], trees: [], required: ['README.md'] },
  });
  syncBundle({
    root, output: RUNTIME, expected: runtimeOutput(), check,
    label: 'Codex runtime', command: 'node scripts/build-codex-plugin.js',
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
