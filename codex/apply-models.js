#!/usr/bin/env node
/**
 * Apply the Codex model roles: write `model` and `model_reasoning_effort` from `$CODEX_HOME/harness-useful-skills/models.yml`
 * into the generated `$CODEX_HOME/agents/us-<role>.toml`. The installer does the same on every install, because Codex
 * has no session hook to do it. This is the explicit step for a changed models file:
 *   node codex/apply-models.js [--json]
 * It runs from the installed runtime and from a checkout (`./useful-skills models apply --host codex`), needs no
 * `codex` command, and prints one line per agent (or one JSON object) and exits 1 when it could not apply.
 */
import { readFileSync, realpathSync } from "node:fs";

import { invokedDirectly } from "../entrypoint.js";
import { writeAtomic } from "../model-roles.js";
import { applyPlan, planFiles, recordText, sha256 } from "../opencode/install-files.js";
import { directoryProblem, lstatOrNull, printableText } from "../opencode/paths.js";
import { AGENT_MARKER, readAgents } from "./agents.js";
import { describeSelection, ensureCodexModels, readCodexModels, renderCodexAgent, selectionFor } from "./models.js";
import { AGENT_RELS, RECORD_REL, RUNTIME_DIR, agentRel, atHome, codexHomeFor, readCodexRecord } from "./paths.js";

const sortedFiles = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));

/** The record's files, plus agent files that carry our marker but were not recorded (a lost record): those may be replaced. */
export function adoptMarkedAgents(codexHome, files) {
  const adopted = { ...files };
  for (const rel of AGENT_RELS) {
    const target = atHome(codexHome, rel);
    if (adopted[rel] !== undefined || directoryProblem(codexHome, rel) || !lstatOrNull(target)?.isFile()) continue;
    const data = readFileSync(target);
    if (data.toString("utf8").split("\n")[0] === AGENT_MARKER) adopted[rel] = sha256(data);
  }
  return adopted;
}

/**
 * Write the configured models into the agent files of the install in CODEX_HOME. An agent file that was edited since
 * the install, or is not ours, is left alone. Resolves to `{ configFile, created, agents }` where each agent maps to
 * `{ state, file, selection }` and state is created, updated, ready or conflict; throws when nothing can be applied.
 */
export async function applyCodexModels({ environment = process.env } = {}) {
  const configured = codexHomeFor(environment);
  const codexHome = lstatOrNull(configured) ? realpathSync(configured) : configured;

  const blocked = directoryProblem(codexHome, RECORD_REL);
  if (blocked) throw new Error(`${blocked}; Useful Skills will not read an install record through it.`);

  const recordFile = atHome(codexHome, RECORD_REL);
  const record = readCodexRecord(recordFile, codexHome);
  if (!record) throw new Error(`Useful Skills is not installed for Codex: no install record at ${recordFile}. Run the installer first.`);

  const models = readCodexModels(codexHome);
  if (models.error) throw new Error(`${models.configFile} cannot be used (${models.error}); no agent was changed.`);
  const created = ensureCodexModels(models);

  const templates = await readAgents(atHome(codexHome, `${RUNTIME_DIR}/codex/agents`));
  const owned = adoptMarkedAgents(codexHome, record.files);
  const agentRecord = {};
  const agents = {};

  for (const { role, text } of templates) {
    const rel = agentRel(role);
    const selection = selectionFor(role, models.roles);
    const data = Buffer.from(renderCodexAgent(text, selection));
    const file = atHome(codexHome, rel);

    const plan = planFiles(codexHome, { files: new Map([[rel, data]]) }, owned[rel] === undefined ? {} : { [rel]: owned[rel] }, []);
    if (plan.problems.length > 0) {
      agents[role] = { state: "conflict", file, selection };
      continue;
    }

    const wasMissing = !lstatOrNull(file);
    applyPlan(codexHome, plan, agentRecord);
    agents[role] = { state: plan.writes.length === 0 ? "ready" : wasMissing ? "created" : "updated", file, selection };
  }

  writeAtomic(recordFile, recordText({ ...record, files: sortedFiles({ ...record.files, ...agentRecord }) }));
  return { configFile: models.configFile, created, agents };
}

/** The lines `apply` prints: where the models file is, then each agent and what it uses. */
export function formatApplied({ configFile, created, agents }) {
  const lines = [`Model roles from ${configFile}${created ? " (created with defaults)" : ""}.`];
  for (const [role, { state, file, selection }] of Object.entries(agents)) {
    if (state === "conflict") {
      lines.push(`us-${role}: left alone, ${file} was edited since it was installed or is not a Useful Skills file.`);
    } else {
      lines.push(`us-${role}: ${describeSelection(selection)} (${state}).`);
    }
  }
  if (Object.values(agents).some(({ state }) => state === "created" || state === "updated")) {
    lines.push("Restart Codex to load the changed agents.");
  }

  return printableText(lines.join("\n"));
}

async function main(argv) {
  const json = argv.length === 1 && argv[0] === "--json";
  if (argv.length > 1 || (argv.length === 1 && !json)) {
    process.stderr.write("Usage: apply-models.js [--json]\n");
    return 2;
  }

  try {
    const result = await applyCodexModels();
    process.stdout.write(`${json ? JSON.stringify({ ...result, text: formatApplied(result) }) : formatApplied(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${printableText(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
