import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_MARKER, isGeneratedAgent, writeAtomic } from "../model-roles.js";

const SOURCE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const OMP_MARKER = `${GENERATED_MARKER} for Oh My Pi; edits are replaced on update.`;
const OMP_HEADER = new RegExp(`^---\\r?\\n${OMP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n`);

/** Agent file names (`*.md`) directly inside a directory; empty when the directory does not exist. */
function agentNames(directory) {
  try {
    return readdirSync(directory).filter(name => name.endsWith(".md")).sort();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

/** The file's text when it is a regular file (never a link or special file), undefined when absent, null otherwise. */
function readRegularFile(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) return null;
  return readFileSync(file, "utf8");
}

/** Source agent text with the generated marker as a YAML comment right after the opening `---`. */
function generatedText(source) {
  const opening = /^---\r?\n/.exec(source);
  if (!opening) {
    throw new Error("agent source does not start with frontmatter");
  }
  return `${opening[0]}${OMP_MARKER}\n${source.slice(opening[0].length)}`;
}

function syncAgent(name, sourceDir, targetDir) {
  const file = path.join(targetDir, name);
  try {
    const next = generatedText(readFileSync(path.join(sourceDir, name), "utf8"));
    const existing = readRegularFile(file);
    if (existing === null || (existing !== undefined && !isGeneratedAgent(existing))) {
      return { state: "conflict", file };
    }

    if (existing === next) {
      return { state: "ready", file };
    }

    writeAtomic(file, next);
    return { state: existing === undefined ? "created" : "updated", file };
  } catch (error) {
    return { state: "error", file, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Delete an agent this sync generated (the exact OMP marker line); anything else, including links and agents other
 * Useful Skills generators wrote, stays. True when removed.
 */
function removeIfGenerated(file) {
  const existing = readRegularFile(file);
  if (typeof existing !== "string" || !OMP_HEADER.test(existing)) {
    return false;
  }

  rmSync(file);
  return true;
}

/**
 * OMP's task tool discovers agents only from `<agentDir>/agents`, not from a plugin's `omp.agents`, so copy the
 * bundled agents there. A file Useful Skills did not generate is the user's: it is reported as a conflict and never touched.
 * Generated files whose bundled agent no longer exists are removed.
 *
 * Returns `{ directory, agents }` where each agent maps to `{ state, file }` and state is created, updated, ready,
 * conflict, or error (with `message`); a removed orphan is reported with state removed.
 */
export function syncOmpAgents({ agentDir, sourceDir = SOURCE_DIRECTORY }) {
  const directory = path.join(agentDir, "agents");
  const sources = agentNames(sourceDir);
  const agents = {};

  for (const name of sources) {
    agents[path.basename(name, ".md")] = syncAgent(name, sourceDir, directory);
  }

  for (const name of agentNames(directory)) {
    if (sources.includes(name)) continue;

    const file = path.join(directory, name);
    try {
      if (removeIfGenerated(file)) {
        agents[path.basename(name, ".md")] = { state: "removed", file };
      }
    } catch (error) {
      agents[path.basename(name, ".md")] = { state: "error", file, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { directory, agents };
}

/** Delete every generated agent in `<agentDir>/agents`; returns the removed file paths. User-owned files stay. */
export function removeOmpAgents({ agentDir }) {
  const directory = path.join(agentDir, "agents");
  const removed = [];

  for (const name of agentNames(directory)) {
    const file = path.join(directory, name);
    try {
      if (removeIfGenerated(file)) removed.push(file);
    } catch {
      // Left in place; the next uninstall run tries again.
    }
  }

  return removed;
}
