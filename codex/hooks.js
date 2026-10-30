#!/usr/bin/env node
/**
 * The Codex PreToolUse hook (registered in `$CODEX_HOME/hooks.json` by the installer): nudges toward the code tools
 * when a shell command greps an identifier. It reuses code-hint.js; this file only adapts Codex's input and settings.
 * It never blocks, never writes to stderr, and is silent on every failure and when the code-graph stage is off.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { codeHint, searchTerms } from "../code-hint.js";
import { invokedDirectly } from "../entrypoint.js";
import { DATA_DIRECTORY } from "../names.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { readWorkflowSnapshot } from "../workflow-settings.js";
import { codexSearchInput } from "./hook-input.js";
import { codexHomeFor } from "./paths.js";
import { resolveCodexDataDir } from "./host-context.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** `{ codexHome, dataDir }`: derived from where this runtime is installed, else from the environment (a checkout). */
export function hookLocations(environment = process.env, file = fileURLToPath(import.meta.url)) {
  const runtime = path.dirname(path.dirname(file));
  const root = path.dirname(runtime);
  if (path.basename(runtime) === "runtime" && path.basename(root) === DATA_DIRECTORY) {
    return { codexHome: path.dirname(root), dataDir: path.join(root, "data") };
  }
  const dataDir = resolveCodexDataDir(environment);
  return { codexHome: codexHomeFor(environment), dataDir: typeof dataDir === "string" ? dataDir : undefined };
}

/** The hint text for a Codex PreToolUse input, or undefined. `locations` and `services` are replaced in tests. */
export async function codexHint(input, { environment = process.env, locations, services } = {}) {
  const adapted = codexSearchInput(input);
  if (!adapted || !searchTerms(adapted).length) return undefined;
  const { dataDir } = locations ?? hookLocations(environment);
  if (typeof dataDir !== "string") return undefined;
  // Codex has no settings command, but the shared store under the private data directory is still read: no file
  // means enabled, a disabled or unreadable one means silence.
  const snapshot = await readWorkflowSnapshot({ configDir: dataDir, cwd: adapted.cwd });
  const policy = effectiveWorkflow(snapshot);
  return codeHint(adapted, { enabled: policy.stages["code-graph"]?.effective === "enabled", dataDir, env: environment, services });
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
}

async function main() {
  try {
    const hint = await codexHint(await readInput());
    if (hint) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: hint } })}\n`);
    }
  } catch {
    // A hint is never worth failing a tool call.
  }
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
