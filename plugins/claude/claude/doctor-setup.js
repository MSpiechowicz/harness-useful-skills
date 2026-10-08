import { realpath } from "node:fs/promises";
import path from "node:path";

import { dependencyStatus, ensureDependencies } from "../dependencies.js";
import { createGraphify } from "../graphify.js";
import { SCOPE_COVERS_HOME, SCOPE_HOME_UNKNOWN, SCOPE_UNREADABLE, scopeSystem, workspaceMountBlocker, workspaceScopeBlocker } from "../graph-scope.js";
import { executeMemory } from "../memory.js";
import { gitWorkTreeRoot } from "../workflow-settings.js";

const TIME_LIMIT = "time limit reached, run again";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function doctorServices(services = {}, scope = {}) {
  const dependencies = {
    dependencyStatus: services.dependencyStatus ?? dependencyStatus,
    ensureDependencies: services.ensureDependencies ?? ensureDependencies,
  };

  return {
    ...dependencies,
    // Status and build share one Graphify instance so they observe the same dependency runtime,
    // and the build enforces the same home and mount scope that doctor checks.
    graphify: services.graphify ?? createGraphify({ ...dependencies, runProcess: services.runProcess, scope }),
    executeMemory: services.executeMemory ?? executeMemory,
  };
}

/** Step results carry a state: ok, pending (setup still needed), failed, or skipped (intentionally not run). */
function step(outcome, state = "ok", detail = undefined) {
  return { outcome, state, ...(detail ? { detail } : {}) };
}

async function factsStep({ memory, check }) {
  if (check) {
    const { exists } = await memory.inspect();
    return exists ? step("existing") : step("missing", "pending");
  }

  const { created } = await memory.ensure();
  return step(created ? "created" : "existing");
}

/**
 * The project's scope blocker, unless a usable graph already exists. Dependencies only serve the graph
 * build, so the same reason lets setup leave them uninstalled; an unreadable graph status is no reason to
 * install them for a project whose scope refuses a build.
 */
async function graphSkipReason({ services, cwd, agentDir, graphBlocker }) {
  const status = await services.graphify.graphStatus({ cwd, agentDir });

  if (status.available && !status.error) {
    return undefined;
  }

  return graphBlocker();
}

async function dependenciesStep(context) {
  const { services, agentDir, check, signal } = context;
  const status = await services.dependencyStatus({ agentDir });

  if (status?.ready === true || status?.state === "ready") {
    return step("ready");
  }

  if (status?.state === "unsupported") {
    return step("unsupported", "failed", status.reason);
  }

  if (status?.state !== "missing" && status?.state !== "partial") {
    return step("failed", "failed", status?.reason ?? "Dependency status is unknown.");
  }

  const missing = status.state === "missing" ? "missing" : "incomplete";
  const skipReason = await graphSkipReason(context);
  if (skipReason) {
    return step(check ? missing : "skipped", "ok", skipReason);
  }

  if (check) {
    return step(missing, "pending");
  }

  await services.ensureDependencies({ agentDir, signal });
  return step("installed");
}

function graphCounts(snapshot) {
  const { nodes, edges } = snapshot ?? {};
  if (Number.isSafeInteger(nodes) && Number.isSafeInteger(edges)) {
    return ` (${nodes} nodes, ${edges} edges)`;
  }

  return "";
}

const HOME_UNKNOWN = "home directory cannot be determined safely";
const HOME_COVERED = "project's Git work tree includes the home directory or is the filesystem root";
const PROJECT_UNREADABLE = "project directory identity cannot be checked";
const DOCTOR_SCOPE_REASONS = new Map([
  [SCOPE_HOME_UNKNOWN, HOME_UNKNOWN],
  [SCOPE_COVERS_HOME, HOME_COVERED],
  [SCOPE_UNREADABLE, PROJECT_UNREADABLE],
]);

/**
 * Doctor only builds inside a Git checkout. The home, filesystem-root, and mount rules are the same ones
 * every Graphify build enforces, applied here to both the project and its Git work tree.
 */
async function graphBuildBlocker(cwd, scope) {
  const workTree = await gitWorkTreeRoot(cwd);
  if (!workTree) {
    return "not a Git repository";
  }

  const project = await realpath(cwd).catch(() => path.resolve(cwd));
  const scopeReason = await workspaceScopeBlocker([project, workTree], scope);
  if (scopeReason) {
    return DOCTOR_SCOPE_REASONS.get(scopeReason) ?? scopeReason;
  }

  return workspaceMountBlocker(project, scope);
}

async function graphStep({ services, cwd, agentDir, check, signal, graphBlocker }) {
  const status = await services.graphify.graphStatus({ cwd, agentDir });

  if (status.error) {
    return step("error", "failed", status.error);
  }

  if (status.available) {
    return step(`existing${graphCounts(status.snapshot)}`);
  }

  const blocker = await graphBlocker();
  if (blocker) {
    return step(check ? "not built" : "skipped", "ok", blocker);
  }

  if (check) {
    return step("missing", "pending");
  }

  const built = await services.graphify.buildGraph({ cwd, agentDir, signal });
  if (!built.ok) {
    return step("failed", "failed", built.error);
  }

  return step(`built${graphCounts(built.snapshot)}`);
}

/**
 * Claude doctor memory setup. `check` inspects only; otherwise it creates the private facts store,
 * installs pinned Graphify dependencies, and builds a missing graph. When no graph exists and the project's
 * scope blocks a build, dependencies are left uninstalled and both steps report the scope reason. Returns per-step outcomes,
 * the resulting memory status, whether everything is ready, and whether the time budget cut setup short.
 * `home` adds a protected home directory to the system ones; `system` overrides `homedir`, `userInfo`, `stat`,
 * and `readMountInfo`.
 */
export async function runClaudeDoctor({ cwd, agentDir, memory, check = false, signal, services, home, system } = {}) {
  const scope = { home, system: scopeSystem(system) };
  const runtime = doctorServices(services, scope);

  // The scope is checked once so the dependency and graph steps agree; the build itself re-checks it.
  let blocker;
  const graphBlocker = () => {
    blocker ??= graphBuildBlocker(cwd, scope);
    return blocker;
  };

  const context = { services: runtime, cwd, agentDir, memory, check, signal, graphBlocker };
  const plan = [
    ["Facts", factsStep],
    ["Dependencies", dependenciesStep],
    ["Graph", graphStep],
  ];

  const steps = [];
  let failed = false;
  let pending = false;

  for (const [label, run] of plan) {
    let result;
    if (signal?.aborted) {
      result = step("skipped", "failed", TIME_LIMIT);
    } else if (failed) {
      result = step("skipped", "skipped", "an earlier step failed");
    } else {
      try {
        result = await run(context);
      } catch (error) {
        result = step("failed", "failed", errorMessage(error));
      }

      if (result.state === "failed" && signal?.aborted) {
        result = step("failed", "failed", TIME_LIMIT);
      }
    }

    failed ||= result.state === "failed";
    pending ||= result.state === "pending";
    steps.push({ label, outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}) });
  }

  const status = await runtime.executeMemory({ action: "status" }, { cwd, agentDir, memory });
  const timedOut = steps.some(({ detail }) => detail === TIME_LIMIT);
  return { steps, memory: status, ok: !failed && !pending, timedOut };
}
