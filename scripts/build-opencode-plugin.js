#!/usr/bin/env node
// Builds plugins/opencode: the OpenCode bundle. The installer copies it into an OpenCode scope as
// <scope>/plugins/useful-skills.js (entry) plus <scope>/plugins/useful-skills/** (runtime tree, same relative layout as this repository).
// plugins/opencode/README.md is hand-written; the generator never touches it.
import { readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOutput, readSource, syncBundle, trackedFiles } from './bundle-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'plugins/opencode';
const RUNTIME = 'useful-skills';
const check = process.argv[2] === '--check';
if (process.argv.length > 3 || (process.argv[2] && !check)) {
  throw new Error('Usage: node scripts/build-opencode-plugin.js [--check]');
}

const PRESERVED = { files: ['README.md'], trees: [], required: ['README.md'] };
// One default export serves both plugin APIs: OpenCode 1.x calls its `server`, OpenCode 2.x its `setup` (see opencode/entry.js).
const ENTRY = 'export { default } from "./useful-skills/opencode/entry.js";\n';

// Every runtime file, as repository-relative paths. Skills are the only walked folder; nothing else is matched by pattern.
// opencode/install.js and uninstall.js run only from a checkout and are deliberately absent; the closure check below
// keeps the bundle honest about modules the runtime still imports (install-status.js needs config-file.js and install-files.js).
const FILES = [
  // Root runtime modules reached by importing opencode/*.js (and the files they spawn or read).
  'doctor.js', 'resources.js', 'workflow-policy.js', 'workflow-settings.js', 'memory.js',
  'graphify.js', 'graph-safety.js', 'graph-storage.js', 'graph-validation.js',
  'graph-import-provenance.js', 'graph-import-provenance.py', 'graph-placeholder-imports.js',
  'graph-scope.js', 'graph-mounts.js', 'path-boundary.js', 'process.js',
  'setup-lock.js', 'setup-runner.js', 'setup-watchdog.js',
  'dependencies.js', 'dependency-policy.js', 'dependency-transport.js',
  // Host-neutral modules shared with the other adapters.
  'workflow-context.js', 'tool-safety.js', 'command-core.js', 'model-roles.js',
  'doctor-setup.js', 'local-facts.js', 'host-roots.js', 'mcp-memory-server.js',
  'entrypoint.js', 'graph-test.js', 'release-check.js',
  // OpenCode adapter.
  'opencode/entry.js', 'opencode/v1.js', 'opencode/v2.js', 'opencode/v2-commands.js', 'opencode/session.js', 'opencode/node-runner.js', 'opencode/context.js',
  'opencode/paths.js', 'opencode/settings.js', 'opencode/host-context.js', 'opencode/models.js',
  'opencode/command.js', 'opencode/hook-cli.js', 'opencode/mcp-server.js',
  'opencode/install-status.js', 'opencode/install-files.js', 'opencode/config-file.js', 'opencode/updater.js',
  'opencode/agents/backend.md', 'opencode/agents/frontend.md', 'opencode/agents/general-purpose.md',
  'opencode/agents/planner.md', 'opencode/agents/reviewer.md', 'opencode/agents/scout.md',
  'opencode/agents/security-reviewer.md',
  'opencode/commands/useful-skills.md', 'opencode/commands/us-ignore-workflow.md',
  // The versioned manifest; becomes useful-skills/package.json (see expectedOutput).
  'opencode/package.json',
  // Pinned dependency metadata Graphify setup verifies.
  'dependencies/manifest.json', 'dependencies/graphify.lock',
  // Licenses: opencode/skills carries text derived from every upstream below, so all of them ship.
  'LICENSE',
  'licenses/caveman/LICENSE.txt', 'licenses/ecc/LICENSE.txt',
  'licenses/graphify/LICENSE-MIT.txt', 'licenses/graphify/LICENSE.txt', 'licenses/graphify/NOTICE.txt',
  'licenses/mattpocock-skills/LICENSE.txt', 'licenses/superpowers/LICENSE.txt',
];

/** Source path -> path inside the bundle. The manifest sits at the runtime root, where the installed code looks for its version. */
const bundlePath = source => `${RUNTIME}/${source === 'opencode/package.json' ? 'package.json' : source}`;

/** The skill folders git tracks below opencode/skills, verified against the canonical skills/us-* set. */
function skillFiles() {
  const canonical = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('us-'))
    .map(entry => entry.name)
    .sort();
  const tracked = trackedFiles(root, OUTPUT, 'opencode/skills');
  const names = [...new Set(tracked.map(path => path.split('/')[2]))].sort();
  if (names.join() !== canonical.join()) {
    throw new Error(`opencode/skills folders (${names.join(', ')}) do not match the canonical skills/us-* set (${canonical.join(', ')})`);
  }
  for (const name of names) {
    if (!tracked.includes(`opencode/skills/${name}/SKILL.md`)) throw new Error(`opencode/skills/${name}/SKILL.md is not tracked by git`);
  }
  return tracked;
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
  if (missing.length > 0) throw new Error(`The OpenCode bundle misses files that bundled modules import:\n${missing.join('\n')}`);
}

function expectedOutput() {
  const runtime = [...FILES, ...skillFiles()].map(source => ({ path: bundlePath(source), content: readSource(root, source) }));
  const files = collectOutput({ root, output: OUTPUT, generated: [{ path: 'useful-skills.js', content: ENTRY }, ...runtime] });
  assertImportClosure(files);
  return files;
}

try {
  syncBundle({
    root,
    output: OUTPUT,
    expected: expectedOutput(),
    check,
    label: 'OpenCode plugin',
    command: 'node scripts/build-opencode-plugin.js',
    preserved: PRESERVED,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
