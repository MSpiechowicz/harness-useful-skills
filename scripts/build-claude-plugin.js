#!/usr/bin/env node
// Builds plugins/claude: a Claude-only plugin bundle with the same relative layout as this repository.
// plugins/claude/README.md and the plugins/claude/evals/ tree (cases for `claude plugin eval`) are hand-written;
// the generator never touches them.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOutput, readSource, syncBundle, trackedFiles } from './bundle-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'plugins/claude';
const check = process.argv[2] === '--check';
if (process.argv.length > 3 || (process.argv[2] && !check)) {
  throw new Error('Usage: node scripts/build-claude-plugin.js [--check]');
}

const PRESERVED = { files: ['README.md'], trees: ['evals'], required: ['README.md'] };

// Every file shipped to Claude. Skills are the only walked folders; nothing else is matched by pattern.
const FILES = [
  // Root runtime modules reached by importing claude/*.js (and the files they spawn or read).
  'doctor.js', 'resources.js', 'workflow-policy.js', 'workflow-settings.js', 'memory.js',
  'graphify.js', 'graph-safety.js', 'graph-storage.js', 'graph-validation.js',
  'graph-import-provenance.js', 'graph-import-provenance.py', 'graph-placeholder-imports.js',
  'graph-scope.js', 'graph-mounts.js', 'path-boundary.js', 'process.js',
  'setup-lock.js', 'setup-runner.js', 'setup-watchdog.js',
  'dependencies.js', 'dependency-policy.js', 'dependency-transport.js',
  // Host-neutral modules shared with the Claude adapter.
  'workflow-context.js', 'tool-safety.js', 'command-core.js', 'model-roles.js',
  'doctor-setup.js', 'local-facts.js', 'host-roots.js', 'mcp-memory-server.js', 'entrypoint.js',
  'names.js', 'legacy-names.js', 'data-migration.js',
  // Claude adapter.
  'claude/command.js', 'claude/hooks.js', 'claude/mcp-server.js', 'claude/models.js',
  'claude/settings.js', 'claude/context.js', 'claude/host-context.js',
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

function readJson(path) {
  return JSON.parse(readSource(root, path).toString('utf8'));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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
  const tracked = trackedFiles(root, OUTPUT, 'claude/skills');
  // Skill folders ship only what git tracks, so untracked or ignored files never reach the bundle.
  const skillFiles = skills.flatMap(name => {
    const files = tracked.filter(path => path.startsWith(`claude/skills/${name}/`));
    if (!files.includes(`claude/skills/${name}/SKILL.md`)) throw new Error(`claude/skills/${name}/SKILL.md is not tracked by git`);
    return files;
  });
  return collectOutput({
    root,
    output: OUTPUT,
    sources: [...FILES, ...skillFiles],
    generated: [
      { path: '.claude-plugin/plugin.json', content: json(manifest(skills)) },
      { path: 'package.json', content: json({ name: 'harness-useful-skills-claude', private: true, type: 'module' }) },
    ],
  });
}

try {
  syncBundle({
    root,
    output: OUTPUT,
    expected: expectedOutput(),
    check,
    label: 'Claude plugin',
    command: 'node scripts/build-claude-plugin.js',
    preserved: PRESERVED,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
