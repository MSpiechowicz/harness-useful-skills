/**
 * The host-independent `/useful-skills` command. A host adapter supplies a profile and gets back a
 * `runCommand(argv, options)` that never throws and resolves to `{ text, exitCode }`.
 *
 * Host profile:
 * - `profileLabel`: host name in status text, as in "this <label> profile" (e.g. "Claude").
 * - `help`: the full help text; `/useful-skills`, `/useful-skills help`, and every usage error print it.
 *   Hosts compose it from WORKFLOW_USAGE and STAGE_USAGE plus their own chat and terminal commands.
 * - `resourceRoot`: the resource tree that `list` and `doctor` inventory.
 * - `catalogUsage(usage)`: rewrites a resource's OMP usage (`/skill:<name>`) into the host's invocation.
 * - `readWorkflow({ environment, cwd })`: resolves to the host's workflow settings snapshot.
 * - `profileDir(environment)`: the host config dir that holds the settings store; called only before writing a
 *   setting, so it may create a missing dir. Its real path is what the store writes under.
 * - `projectRoot({ environment, cwd })`: the project directory `doctor` works on.
 * - `resolveDoctorHost({ environment, workspace, packageRoot })`: resolves to `{ host }`, the
 *   `{ cwd, agentDir, memory }` doctor setup needs, or `{ reason }` when memory cannot be located safely.
 * - `runDoctor(options)`: doctor memory setup, normally doctor-setup.js `runDoctorSetup`.
 * - Optional `legacyNotes({ environment })`: lines naming what an earlier (pre-rename) install left behind, which
 *   `doctor` appends to its report.
 * - Exactly one of `updateGuidance` (fixed text for `update check|install`) or
 *   `update(action, context)` (a handler for action "check" or "install").
 * - Exactly one of `graphGuidance` (fixed text for any `graph ...` command) or
 *   `graph(args, context)` (a handler for the tokens after `graph`).
 *
 * Handlers receive `context` = the runCommand options with defaults applied plus `usage(message, exitCode = 2)`,
 * which builds the standard usage error. They resolve to `{ text, exitCode }`; a thrown error becomes a usage
 * error with exit code 1.
 */
import { realpath } from "node:fs/promises";
import { formatDoctor } from "./doctor.js";
import { formatResources, listResources, PACKAGE_ROOT, parseCatalogArguments, redactText, resourceInventory } from "./resources.js";
import { effectiveWorkflow } from "./workflow-policy.js";
import { STAGES, writeWorkflowSetting } from "./workflow-settings.js";

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

export const WORKFLOW_USAGE = "workflow enabled|disabled";
export const STAGE_USAGE = `stage <${STAGES.join("|")}> enabled|disabled`;

export function commandResult(text, exitCode = 0) {
  return { text, exitCode };
}

/**
 * Escape control, line-separator, and invisible format (bidi, zero-width) characters so untrusted
 * paths and errors stay on one visibly faithful text line. Astral characters escape as surrogate pairs.
 */
export function printable(text) {
  const escapeUnit = unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;

  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, character => (
    character.split("").map(escapeUnit).join("")
  ));
}

/** A redacted, printable message for an error of any type. */
export function errorMessage(error) {
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

function statusText(snapshot, profileLabel) {
  const data = statusData(snapshot);
  const line = (label, { saved, effective, source, error }, reason = error) => (
    `${label}: saved ${saved}, effective ${effective}, source ${source}${reason ? ` (${printable(redactText(reason))})` : ""}`
  );

  return [
    `Useful Skills repository workflow and ${profileLabel} profile stage settings:`,
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

/** Throw unless the host profile supplies exactly one of a fixed guidance text or a handler for a command. */
function assertOneOf(host, guidance, handler) {
  const hasGuidance = typeof host[guidance] === "string";
  const hasHandler = typeof host[handler] === "function";
  if (hasGuidance === hasHandler) {
    throw new TypeError(`A command host profile needs exactly one of ${guidance} (text) or ${handler} (function).`);
  }
}

/** Bind the `/useful-skills` subcommands to one host profile (see the module comment); throws on a misconfigured profile. */
export function createCommandRunner(host) {
  assertOneOf(host, "updateGuidance", "update");
  assertOneOf(host, "graphGuidance", "graph");

  function usage(message, exitCode = 2) {
    return commandResult(`${message}\n${host.help}`, exitCode);
  }

  async function status(tokens, context) {
    const snapshot = await host.readWorkflow(context);
    if (tokens.length === 1) {
      return commandResult(statusText(snapshot, host.profileLabel));
    }

    if (tokens.length === 2 && tokens[1] === "--json") {
      return commandResult(JSON.stringify(statusData(snapshot)));
    }

    return usage("Expected /useful-skills status [--json].");
  }

  async function setting(tokens, context) {
    const stageCommand = tokens[0] === "stage";
    const key = stageCommand ? stageName(tokens[1]) : "workflow";
    const mode = tokens[stageCommand ? 2 : 1];

    if (tokens.length !== (stageCommand ? 3 : 2) || !key || !MODES.includes(mode)) {
      const snapshot = await host.readWorkflow(context);
      return commandResult(`Expected /useful-skills ${stageCommand ? STAGE_USAGE : WORKFLOW_USAGE}.\n${statusText(snapshot, host.profileLabel)}`, 2);
    }

    try {
      // The store rejects symlinked profile paths, so write through the resolved host config dir.
      const agentDir = await realpath(host.profileDir(context.environment));
      await writeWorkflowSetting({ agentDir, cwd: context.cwd, key, enabled: mode === "enabled" });
    } catch (error) {
      return commandResult(`Cannot change ${key}: ${errorMessage(error)}`, 1);
    }

    const confirmed = await host.readWorkflow(context);
    const policy = effectiveWorkflow(confirmed);
    const saved = key === "workflow" ? policy.workflow.saved : policy.stages[key].saved;
    if (confirmed.errors[key] || confirmed.sources[key] !== "file" || saved !== mode) {
      const reason = confirmed.errors[key] || "scoped readback differs from the requested mode";
      return commandResult(`Cannot confirm ${key} setting: ${printable(redactText(reason))}.\n${statusText(confirmed, host.profileLabel)}`, 1);
    }

    const scope = stageCommand ? `this ${host.profileLabel} profile` : `this repository/workspace (${printable(confirmed.scopeRoot)})`;
    return commandResult(`Useful Skills ${key} ${mode} for ${scope}.`);
  }

  async function doctor(tokens, { environment, cwd, packageRoot, doctorServices, doctorBudgetMs }) {
    const check = tokens[1] === "--check";
    if (tokens.length > 2 || (tokens.length === 2 && !check)) {
      return usage("Expected /useful-skills doctor [--check].");
    }

    const mode = check ? "check" : "setup";
    const projectRoot = host.projectRoot({ environment, cwd });
    const [core, snapshot] = await Promise.all([
      resourceInventory({ root: host.resourceRoot }),
      host.readWorkflow({ environment, cwd: projectRoot }),
    ]);
    const settings = doctorSettings(snapshot);
    const leftovers = host.legacyNotes ? host.legacyNotes({ environment }) : [];
    const withLeftovers = report => (leftovers.length > 0 ? `${report}\n${["Leftover from an earlier install", ...leftovers.map(note => `  ${printable(note)}`)].join("\n")}` : report);

    // Every host adapter applies the command guard to shell tools.
    const { host: doctorHost, reason } = await host.resolveDoctorHost({ environment, workspace: projectRoot, packageRoot });
    if (!doctorHost) {
      const unavailable = printable(redactText(reason));
      return commandResult(withLeftovers(formatDoctor({ core, safety: true, setup: { mode, settings, steps: [], ok: false, unavailable } })), 1);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), doctorBudgetMs);
    let outcome;
    try {
      outcome = await host.runDoctor({ ...doctorHost, check, signal: controller.signal, services: doctorServices });
    } finally {
      clearTimeout(timer);
    }

    const steps = outcome.steps.map(({ label, outcome: stepOutcome, detail }) => ({
      label,
      outcome: stepOutcome,
      ...(detail ? { detail: doctorDetail(detail, doctorHost.agentDir) } : {}),
    }));
    const memory = doctorMemory(outcome.memory, doctorHost.agentDir);
    const report = formatDoctor({ core, safety: true, memory, setup: { mode, settings, steps, ok: outcome.ok, timedOut: outcome.timedOut } });
    return commandResult(withLeftovers(report), outcome.ok ? 0 : 1);
  }

  async function catalog(tokens) {
    let parsed;
    try {
      parsed = parseCatalogArguments(tokens);
    } catch (error) {
      return usage(errorMessage(error));
    }

    const { kind, query } = parsed;
    const resources = await listResources(kind, { root: host.resourceRoot, query });
    const items = resources.map(resource => ({ ...resource, usage: host.catalogUsage(resource.usage) }));
    return commandResult(formatResources(kind, items, query));
  }

  async function update(tokens, context) {
    if (tokens.length !== 2 || !["check", "install"].includes(tokens[1])) {
      return usage("Expected /useful-skills update check|install.");
    }

    if (host.update) {
      return await host.update(tokens[1], context);
    }

    return commandResult(host.updateGuidance);
  }

  async function graph(tokens, context) {
    if (host.graph) {
      return await host.graph(tokens.slice(1), context);
    }

    return commandResult(host.graphGuidance);
  }

  /** Run one `/useful-skills` subcommand for this host; never throws. */
  return async function runCommand(argv, {
    environment = process.env,
    cwd = process.cwd(),
    packageRoot = PACKAGE_ROOT,
    doctorBudgetMs = DOCTOR_BUDGET_MS,
    ...options
  } = {}) {
    const tokens = commandTokens(argv);
    if (!tokens) {
      return usage(`Expected at most ${MAX_ARGUMENTS} arguments of at most ${MAX_ARGUMENT_LENGTH} characters each.`);
    }

    const context = { environment, cwd };
    const handlerContext = { ...options, environment, cwd, packageRoot, doctorBudgetMs, usage };
    try {
      switch (tokens[0]) {
        case undefined:
          return commandResult(host.help);
        case "help":
          return tokens.length === 1 ? commandResult(host.help) : usage("Expected /useful-skills help.");
        case "status":
          return await status(tokens, context);
        case "workflow":
        case "stage":
          return await setting(tokens, context);
        case "doctor":
          return await doctor(tokens, handlerContext);
        case "list":
          return await catalog(tokens);
        case "update":
          return await update(tokens, handlerContext);
        case "graph":
          return await graph(tokens, handlerContext);
        default:
          return usage("Unknown /useful-skills command.");
      }
    } catch (error) {
      return usage(errorMessage(error), 1);
    }
  };
}
