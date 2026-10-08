#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctor } from "../doctor.js";
import { formatResources, listResources, PACKAGE_ROOT, parseCatalogArguments, redactText, resourceInventory } from "../resources.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { STAGES, writeWorkflowSetting } from "../workflow-settings.js";
import { runClaudeDoctor } from "./doctor-setup.js";
import { claudePluginDataDir, resolveHostContext } from "./host-context.js";
import { claudeConfigDir } from "./models.js";
import { readClaudeWorkflow } from "./settings.js";

const CLAUDE_ROOT = path.join(PACKAGE_ROOT, "claude");
const MAX_ARGUMENTS = 8;
const MAX_ARGUMENT_LENGTH = 256;
const DOCTOR_BUDGET_MS = 540_000;
const MODES = Object.freeze(["enabled", "disabled"]);
const STAGE_ALIASES = Object.freeze({
  security_review: "security-review",
  backend_memory: "backend-memory",
  graphify_memory: "graphify-memory",
});
const STAGE_LABELS = Object.freeze({
  research: "Research",
  plan: "Plan",
  review: "Review",
  "security-review": "Security review",
  "backend-memory": "Backend memory",
  "graphify-memory": "Graphify memory",
});
const WORKFLOW_USAGE = "workflow enabled|disabled";
const STAGE_USAGE = `stage <${STAGES.join("|")}> enabled|disabled`;

const HELP = [
  "Useful Skills for Claude Code",
  "/useful-skills:us-<name> — load an owned skill; natural requests also select skills by description.",
  "/useful-skills list [query] — browse owned skills.",
  `/useful-skills ${WORKFLOW_USAGE} — set the development workflow for this repository/checkout (default: enabled); outside Git, scoped to the canonical workspace.`,
  `/useful-skills ${STAGE_USAGE} — set an independent automatic stage for this Claude profile.`,
  "/useful-skills status [--json] — read repository workflow and profile stage settings, their sources, paths, and errors.",
  "/useful-skills:us-ignore-workflow — use the fast lane for one explicit request without changing saved settings.",
  "/useful-skills doctor [--check] — set up this project's memory (private facts store, pinned Graphify dependencies, graph) and report status; --check only reports status and writes nothing.",
  "/useful-skills update check|install — show how Claude Code updates this plugin.",
  "Memory: use the `memory_status`, `graph_build`, and `graph_query` MCP tools.",
  "A saved setting overrides the plugin option of the same name; without either, the setting is enabled.",
].join("\n");
const UPDATE_GUIDANCE = "Claude Code updates the plugin itself: use `/plugin` (Installed tab) or run `claude plugin update useful-skills@<marketplace>`, then `/reload-plugins`.";
const GRAPH_GUIDANCE = "Graph diagnostics in Claude Code use the `graph_build` and `graph_query` MCP tools: ask Claude to build this workspace's graph, then query it. `memory_status` reports graph state without building.";

function result(text, exitCode = 0) {
  return { text, exitCode };
}

function usage(message, exitCode = 2) {
  return result(`${message}\n${HELP}`, exitCode);
}

/**
 * Escape control, line-separator, and invisible format (bidi, zero-width) characters so untrusted
 * paths and errors stay on one visibly faithful text line. Astral characters escape as surrogate pairs.
 */
function printable(text) {
  const escapeUnit = unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;

  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, character => (
    character.split("").map(escapeUnit).join("")
  ));
}

function errorMessage(error) {
  return printable(redactText(error instanceof Error ? error.message : String(error)));
}

function stageName(token) {
  const name = STAGE_ALIASES[token] ?? token;
  return STAGES.includes(name) ? name : undefined;
}

function entry(policyEntry, snapshot, key) {
  const error = snapshot.errors[key];
  return {
    saved: policyEntry.saved,
    effective: policyEntry.effective,
    source: snapshot.sources[key],
    ...(error ? { error: redactText(error) } : {}),
  };
}

function statusData(snapshot) {
  const policy = effectiveWorkflow(snapshot);
  return {
    scopeRoot: snapshot.scopeRoot ?? null,
    workflowFile: snapshot.workflowFile ?? null,
    directory: snapshot.directory ?? null,
    workflow: entry(policy.workflow, snapshot, "workflow"),
    stages: Object.fromEntries(STAGES.map(stage => [stage, entry(policy.stages[stage], snapshot, stage)])),
  };
}

function statusText(snapshot) {
  const data = statusData(snapshot);
  const line = (label, { saved, effective, source, error }, reason = error) => (
    `${label}: saved ${saved}, effective ${effective}, source ${source}${reason ? ` (${printable(redactText(reason))})` : ""}`
  );

  return [
    "Useful Skills repository workflow and Claude profile stage settings:",
    `Workflow scope root: ${printable(data.scopeRoot ?? "unknown")}`,
    `Repository workflow file: ${printable(data.workflowFile ?? "unknown")}`,
    `Profile stage directory: ${printable(data.directory ?? "unknown")}`,
    line("Workflow", data.workflow),
    ...STAGES.map(stage => {
      const stageEntry = data.stages[stage];
      let reason = stageEntry.error;
      if (!reason && data.workflow.saved === "disabled") {
        reason = "workflow disabled";
      } else if (!reason && data.workflow.saved === "unknown") {
        reason = "workflow setting unreadable";
      }

      return line(STAGE_LABELS[stage], stageEntry, reason);
    }),
  ].join("\n");
}

async function status(tokens, context) {
  const snapshot = await readClaudeWorkflow(context);
  if (tokens.length === 1) {
    return result(statusText(snapshot));
  }

  if (tokens.length === 2 && tokens[1] === "--json") {
    return result(JSON.stringify(statusData(snapshot)));
  }

  return usage("Expected /useful-skills status [--json].");
}

async function setting(tokens, context) {
  const stageCommand = tokens[0] === "stage";
  const key = stageCommand ? stageName(tokens[1]) : "workflow";
  const mode = tokens[stageCommand ? 2 : 1];

  if (tokens.length !== (stageCommand ? 3 : 2) || !key || !MODES.includes(mode)) {
    const snapshot = await readClaudeWorkflow(context);
    return result(`Expected /useful-skills ${stageCommand ? STAGE_USAGE : WORKFLOW_USAGE}.\n${statusText(snapshot)}`, 2);
  }

  try {
    // The store rejects symlinked profile paths, so write through the resolved Claude config dir.
    const agentDir = await realpath(claudeConfigDir(context.environment));
    await writeWorkflowSetting({ agentDir, cwd: context.cwd, key, enabled: mode === "enabled" });
  } catch (error) {
    return result(`Cannot change ${key}: ${errorMessage(error)}`, 1);
  }

  const confirmed = await readClaudeWorkflow(context);
  const policy = effectiveWorkflow(confirmed);
  const saved = key === "workflow" ? policy.workflow.saved : policy.stages[key].saved;
  if (confirmed.errors[key] || confirmed.sources[key] !== "file" || saved !== mode) {
    const reason = confirmed.errors[key] || "scoped readback differs from the requested mode";
    return result(`Cannot confirm ${key} setting: ${printable(redactText(reason))}.\n${statusText(confirmed)}`, 1);
  }

  const scope = stageCommand ? "this Claude profile" : `this repository/workspace (${printable(confirmed.scopeRoot)})`;
  return result(`Useful Skills ${key} ${mode} for ${scope}.`);
}

function doctorSettings(snapshot) {
  const policy = effectiveWorkflow(snapshot);
  const setting = (label, key, saved) => ({
    label,
    saved,
    source: snapshot.sources[key],
    ...(snapshot.errors[key] ? { error: printable(redactText(snapshot.errors[key])) } : {}),
  });

  return [
    setting("Workflow", "workflow", policy.workflow.saved),
    ...STAGES.map(stage => setting(STAGE_LABELS[stage], stage, policy.stages[stage].saved)),
  ];
}

/** Resolve the project and Claude plugin data roots, or return a printable reason they cannot be trusted. */
async function doctorHost({ environment, workspace, packageRoot }) {
  const located = await claudePluginDataDir({ environment, packageRoot });
  if (located.reason) {
    return { reason: located.reason };
  }

  try {
    return { host: await resolveHostContext({ workspace, data: located.dataDir }) };
  } catch (error) {
    // System errors embed raw paths; keep only the validation messages.
    return { reason: error?.code ? "Claude project root or plugin data directory cannot be resolved." : errorMessage(error) };
  }
}

/** Escape and redact a step detail, hiding the plugin data directory path. */
function doctorDetail(detail, dataDir) {
  if (!detail) {
    return undefined;
  }

  return printable(redactText(String(detail).split(dataDir).join("<plugin data>")));
}

/** Apply `doctorDetail` to every string in a memory status so its rendered errors are masked like step details. */
function doctorMemory(value, dataDir) {
  if (typeof value === "string") {
    return doctorDetail(value, dataDir);
  }

  if (Array.isArray(value)) {
    return value.map(item => doctorMemory(item, dataDir));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, doctorMemory(item, dataDir)]));
  }

  return value;
}

async function doctor(tokens, { environment, cwd, packageRoot, doctorServices, doctorBudgetMs }) {
  const check = tokens[1] === "--check";
  if (tokens.length > 2 || (tokens.length === 2 && !check)) {
    return usage("Expected /useful-skills doctor [--check].");
  }

  const mode = check ? "check" : "setup";
  const projectDir = environment.CLAUDE_PROJECT_DIR;
  const projectRoot = projectDir && path.isAbsolute(projectDir) ? projectDir : cwd;
  const [core, snapshot] = await Promise.all([
    resourceInventory({ root: CLAUDE_ROOT }),
    readClaudeWorkflow({ environment, cwd: projectRoot }),
  ]);
  const settings = doctorSettings(snapshot);

  // Claude hooks always apply the command guard.
  const { host, reason } = await doctorHost({ environment, workspace: projectRoot, packageRoot });
  if (!host) {
    const unavailable = printable(redactText(reason));
    return result(formatDoctor({ core, safety: true, setup: { mode, settings, steps: [], ok: false, unavailable } }), 1);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), doctorBudgetMs);
  let outcome;
  try {
    outcome = await runClaudeDoctor({ ...host, check, signal: controller.signal, services: doctorServices });
  } finally {
    clearTimeout(timer);
  }

  const steps = outcome.steps.map(({ label, outcome: stepOutcome, detail }) => ({
    label,
    outcome: stepOutcome,
    ...(detail ? { detail: doctorDetail(detail, host.agentDir) } : {}),
  }));
  const memory = doctorMemory(outcome.memory, host.agentDir);
  const report = formatDoctor({ core, safety: true, memory, setup: { mode, settings, steps, ok: outcome.ok, timedOut: outcome.timedOut } });
  return result(report, outcome.ok ? 0 : 1);
}

async function catalog(tokens) {
  let parsed;
  try {
    parsed = parseCatalogArguments(tokens);
  } catch (error) {
    return usage(errorMessage(error));
  }

  const { kind, query } = parsed;
  const resources = await listResources(kind, { root: CLAUDE_ROOT, query });

  // Claude namespaces plugin skills.
  const items = resources.map(resource => ({
    ...resource,
    usage: resource.usage.replace(/^\/skill:/, "/useful-skills:"),
  }));
  return result(formatResources(kind, items, query));
}

/** Split host arguments like OMP's text input, or return undefined for an oversized or malformed command. */
function commandTokens(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS) {
    return undefined;
  }

  if (!argv.every(token => typeof token === "string" && token.length <= MAX_ARGUMENT_LENGTH)) {
    return undefined;
  }

  const tokens = argv.flatMap(token => token.trim().split(/\s+/)).filter(Boolean);
  return tokens.length <= MAX_ARGUMENTS ? tokens : undefined;
}

/** Run one `/useful-skills` subcommand for Claude Code; never throws. */
export async function runCommand(argv, {
  environment = process.env,
  cwd = process.cwd(),
  packageRoot = PACKAGE_ROOT,
  doctorServices,
  doctorBudgetMs = DOCTOR_BUDGET_MS,
} = {}) {
  const tokens = commandTokens(argv);
  if (!tokens) {
    return usage(`Expected at most ${MAX_ARGUMENTS} arguments of at most ${MAX_ARGUMENT_LENGTH} characters each.`);
  }

  const context = { environment, cwd };
  try {
    switch (tokens[0]) {
      case undefined:
        return result(HELP);
      case "help":
        return tokens.length === 1 ? result(HELP) : usage("Expected /useful-skills help.");
      case "status":
        return await status(tokens, context);
      case "workflow":
      case "stage":
        return await setting(tokens, context);
      case "doctor":
        return await doctor(tokens, { ...context, packageRoot, doctorServices, doctorBudgetMs });
      case "list":
        return await catalog(tokens);
      case "update":
        if (tokens.length === 2 && ["check", "install"].includes(tokens[1])) {
          return result(UPDATE_GUIDANCE);
        }

        return usage("Expected /useful-skills update check|install.");
      case "graph":
        return result(GRAPH_GUIDANCE);
      default:
        return usage("Unknown /useful-skills command.");
    }
  } catch (error) {
    return usage(errorMessage(error), 1);
  }
}

/** True when Node runs this file as the entry script, including through a symlinked install path. */
function invokedDirectly() {
  if (!process.argv[1]) {
    return false;
  }

  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return process.argv[1] === self;
  }
}

if (invokedDirectly()) {
  const { text, exitCode } = await runCommand(process.argv.slice(2));
  (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = exitCode;
}
