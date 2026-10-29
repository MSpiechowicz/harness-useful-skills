import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeMemory } from "./memory.js";
import { isPathWithin } from "./path-boundary.js";

const TIME_LIMIT = "time limit reached, run again";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function doctorServices(services = {}) {
  return {
    probeCodeGraph: services.probeCodeGraph ?? probeCodeGraph,
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

const PROBE_TERM_MS = 2500;
const PROBE_KILL_MS = 3000;
const PROBE_GIVE_UP_MS = 3300;

function notFound() {
  return step("harness-memory not found", "ok", "install Harness Memory for the code_map, code_symbol, code_impact and code_path tools");
}

function usableFile(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** The checkout around `directory`: the nearest folder above it holding `.git`, else `directory` itself. */
function checkoutRoot(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return directory;
  }
}

/** Whether `file` lies in `root`; case-insensitive where the file system usually is (macOS, Windows). */
function inside(root, file, platform) {
  const fold = platform === "darwin" || platform === "win32" ? text => text.toLowerCase() : text => text;
  return isPathWithin(fold(root), fold(file));
}

/**
 * Real path of `harness-memory`, or undefined. Only absolute PATH entries count, and a candidate whose real path lies
 * in the checkout around `cwd` is skipped, so neither an empty or relative entry nor a binary planted in the repository
 * (directly, through a symbolic link or a differently cased alias) is ever executed. The standard install locations are
 * tried after PATH.
 */
export function resolveHarnessMemory({ cwd, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const windows = platform === "win32";
  const names = windows ? ["harness-memory.exe"] : ["harness-memory"];
  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue.split(windows ? ";" : ":").filter(entry => entry && path.isAbsolute(entry));
  if (windows) {
    if (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) directories.push(path.join(env.LOCALAPPDATA, "Programs", "harness-memory"));
  } else if (home && path.isAbsolute(home)) {
    directories.push(path.join(home, ".local", "bin"));
  }

  const workspace = typeof cwd === "string" && cwd ? realPath(path.resolve(cwd)) ?? path.resolve(cwd) : undefined;
  const guarded = workspace ? checkoutRoot(workspace) : undefined;
  for (const directory of directories) {
    for (const name of names) {
      const candidate = realPath(path.join(directory, name));
      if (!candidate) continue;
      if (guarded && inside(guarded, candidate, platform)) continue;
      if (usableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/**
 * Informational only: whether the installed `harness-memory` lists the `code-index` feature. A missing binary or an
 * older build is reported, never a failure. The binary runs from an absolute path in a neutral directory and is
 * stopped (SIGTERM, then SIGKILL) within about 3.5 seconds.
 */
export function probeCodeGraph(execute = execFile, { cwd, signal, env, platform, home } = {}) {
  return new Promise(resolve => {
    let finished = false;
    let child;
    const timers = [];
    const finish = result => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const stop = name => { try { child?.kill?.(name); } catch { /* already gone */ } };
    function onAbort() {
      stop("SIGKILL");
      finish(notFound());
    }

    try {
      const file = resolveHarnessMemory({ cwd, env, platform, home });
      if (!file || signal?.aborted) {
        finish(notFound());
        return;
      }

      signal?.addEventListener?.("abort", onAbort, { once: true });
      child = execute(file, ["features"], { cwd: os.tmpdir(), windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          finish(notFound());
          return;
        }

        const features = String(stdout).split(/\r?\n/).map(line => line.trim());
        finish(features.includes("code-index")
          ? step("available")
          : step("not available", "ok", "update Harness Memory for the code index"));
      });
      timers.push(setTimeout(() => stop("SIGTERM"), PROBE_TERM_MS));
      timers.push(setTimeout(() => stop("SIGKILL"), PROBE_KILL_MS));
      timers.push(setTimeout(() => finish(notFound()), PROBE_GIVE_UP_MS));
    } catch {
      finish(notFound());
    }
  });
}

async function codeGraphStep({ services, cwd, signal }) {
  return services.probeCodeGraph({ cwd, signal });
}

/**
 * Doctor memory setup shared by host adapters. `check` inspects only; otherwise it creates the private facts store.
 * The "Code graph" line only reports whether Harness Memory offers the code index and never fails doctor. Returns
 * per-step outcomes, the resulting memory status, whether everything is ready, and whether the time budget cut
 * setup short.
 */
export async function runDoctorSetup({ cwd, agentDir, memory, check = false, signal, services } = {}) {
  const runtime = doctorServices(services);
  const context = { services: runtime, cwd, agentDir, memory, check, signal };
  const plan = [
    ["Facts", factsStep],
    ["Code graph", codeGraphStep],
  ];

  const steps = [];
  let failed = false;
  let pending = false;

  for (const [label, run] of plan) {
    let result;
    if (label === "Code graph") {
      // Informational: it runs whatever happened before and its probe has its own short limit.
      result = await run(context).catch(() => step("unknown"));
    } else if (signal?.aborted) {
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
