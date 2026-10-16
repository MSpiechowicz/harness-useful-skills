// Shared renderer for host-specific copies of the canonical skills. Importing has no side effects.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function replace(text, before, after) {
  const first = text.indexOf(before);
  if (first === -1 || text.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one occurrence of ${JSON.stringify(before.slice(0, 90))}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

export function line(text, beginning, replacement) {
  const rows = text.split('\n');
  const matches = rows.flatMap((row, index) => row.startsWith(beginning) ? [index] : []);
  if (matches.length !== 1) throw new Error(`Expected one line starting with ${beginning}`);
  rows[matches[0]] = replacement;
  return rows.join('\n');
}

export function section(text, heading, nextHeading, body) {
  const start = text.indexOf(heading + '\n');
  const end = text.indexOf(nextHeading + '\n', start + heading.length);
  if (start < 0 || end < 0) throw new Error(`Missing section ${heading} or ${nextHeading}`);
  return text.slice(0, start) + heading + '\n\n' + body + '\n\n' + text.slice(end);
}

export function filesUnder(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesUnder(join(directory, entry.name), path);
    return [path];
  });
}

function canonicalSkills(sourceRoot) {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('us-'))
    .map(entry => entry.name);
}

function collectOutput(sourceRoot, adapt) {
  const names = canonicalSkills(sourceRoot);
  const output = new Map();
  for (const name of names) {
    output.set(`${name}/SKILL.md`, adapt(`${name}/SKILL.md`, readFileSync(join(sourceRoot, name, 'SKILL.md'), 'utf8')));
    const references = join(sourceRoot, name, 'references');
    try {
      for (const child of readdirSync(references, { withFileTypes: true })) {
        if (!child.isFile() || !child.name.endsWith('.md')) continue;
        const path = `${name}/references/${child.name}`;
        output.set(path, adapt(path, readFileSync(join(references, child.name), 'utf8')));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  output.set('us-check-code-quality/CODE_QUALITY.md', readFileSync(join(sourceRoot, 'us-check-code-quality', 'CODE_QUALITY.md'), 'utf8'));
  if (names.length !== 20) throw new Error('Expected exactly 20 canonical skills');
  return output;
}

function isStale(output, outputDir) {
  let stale = false;
  for (const [path, content] of output) {
    try {
      if (readFileSync(join(outputDir, path), 'utf8') !== content) stale = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      stale = true;
    }
  }
  return stale || existingFiles(outputDir).some(path => !output.has(path));
}

function existingFiles(directory) {
  try {
    return filesUnder(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

// Validates a renderer's argv tail and returns whether it asks for a check only.
export function parseCheckFlag(args, usage) {
  if (args.length > 1 || (args[0] && args[0] !== '--check')) throw new Error(usage);
  return args[0] === '--check';
}

// Renders every canonical skill through adapt(file, source) into outputDir, or only verifies it when check is set.
// command is the renderer invocation to repeat when the output is stale; source names the canonical origin in messages.
export function renderSkills({ root, outputDir, adapt, check, label, command, source }) {
  const output = collectOutput(join(root, 'skills'), adapt);
  if (check) {
    if (isStale(output, outputDir)) {
      console.error(`${label} skills are stale; run ${command}`);
      process.exitCode = 1;
      return;
    }
  } else {
    for (const [path, content] of output) {
      const destination = join(outputDir, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
  }
  console.log(`${check ? 'Checked' : 'Rendered'} ${output.size} ${label} skill and support files from ${source}`);
}
