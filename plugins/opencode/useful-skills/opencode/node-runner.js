import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { PROCESS_GROUPS_FILE, recordedProcessGroups, signalProcessTree } from "../process.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
// How long an exited child's output may stay open, held by a process outside its group, before the run settles.
const OUTPUT_DRAIN_MS = 1_000;
const OWN_PROCESS_GROUP = process.platform !== "win32";
const HOST_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];

/**
 * Subprocesses still running, shared by every copy of this module in the process (the user and project plugin
 * scopes each load their own), so one set of host hooks ends them all. Version 1 contract: `runs` holds entries
 * with `stop()`, `signal(name)`, `release()`, and `ended`, and `hooks` is the installed hooks' `{ remove() }`.
 * A copy that finds a registry it does not understand keeps a private one and its own hooks.
 */
const REGISTRY_KEY = Symbol.for("useful-skills.node-runner");
const REGISTRY_VERSION = 1;

function sharedRegistry() {
  const existing = globalThis[REGISTRY_KEY];
  if (existing?.version === REGISTRY_VERSION && existing.runs instanceof Set) {
    return existing;
  }

  const registry = { version: REGISTRY_VERSION, runs: new Set(), hooks: undefined };
  if (existing === undefined) {
    Object.defineProperty(globalThis, REGISTRY_KEY, { value: registry });
  }

  return registry;
}

const registry = sharedRegistry();

/** Node.js is not on PATH, so no Useful Skills subprocess can run. */
export class NodeUnavailable extends Error {
  constructor() {
    super("Node.js is not available on PATH.");
    this.name = "NodeUnavailable";
  }
}

function stoppedError() {
  return new Error("The subprocess was stopped.");
}

/** SIGTERM a run's groups now and SIGKILL whatever is left after a short grace period. */
function terminateGroups(run) {
  run.signal("SIGTERM");
  setTimeout(() => run.signal("SIGKILL"), TERMINATION_GRACE_MS).unref();
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Stop every running subprocess in this process and resolve once each one's process groups have been ended. */
export async function terminateAll() {
  const runs = [...registry.runs];
  for (const run of runs) {
    run.stop();
  }

  await Promise.allSettled(runs.map(({ ended }) => ended));
}

/** signal-exit (v3 and v4) leaves a signal to any other listener, so it never ends the host while ours remains. */
function signalExitListenerCount() {
  const counts = [globalThis[Symbol.for("signal-exit emitter")]?.count, process.__signal_exit_emitter__?.count];
  return counts.filter(count => Number.isSafeInteger(count) && count >= 0).reduce((total, count) => total + count, 0);
}

/**
 * A signal can end the host as soon as this listener returns, so the subprocesses are ended synchronously: SIGTERM,
 * a short grace for their own cleanup, then SIGKILL. Our listeners are then removed. The host's own listeners
 * decide what the signal does; with none left but signal-exit's, which defer to ours, the signal is raised again
 * to take its default effect.
 *
 * Intentionally, a host signal cancels every run in flight even when the host's own handler keeps the process
 * alive: the signal asks the host to stop, so its subprocesses are stopped too and their runs reject.
 */
function endRunsOnHostSignal(name) {
  const runs = [...registry.runs];
  for (const run of runs) {
    run.stop();
  }

  sleepSync(TERMINATION_GRACE_MS);
  for (const run of runs) {
    run.signal("SIGKILL");
    run.release();
  }

  registry.hooks?.remove();

  if (process.listenerCount(name) <= signalExitListenerCount()) {
    process.kill(process.pid, name);
  }
}

/** Install the host hooks while any subprocess runs; removed again once none does. */
function installHostHooks() {
  if (registry.hooks) {
    return;
  }

  // Nothing can wait during exit. SIGTERM, unlike SIGKILL, lets a Useful Skills script end its own
  // separately grouped children before it exits (process.js exitOnTermination).
  const onExit = () => {
    for (const run of registry.runs) {
      run.signal("SIGTERM");
      run.release();
    }
  };
  process.on("exit", onExit);

  // A Worker receives no signals, and terminating it emits no exit event: the plugin's dispose hook covers it.
  const signalListeners = new Map();
  if (isMainThread && OWN_PROCESS_GROUP) {
    for (const name of HOST_SIGNALS) {
      signalListeners.set(name, () => endRunsOnHostSignal(name));
    }
  }

  for (const [name, listener] of signalListeners) {
    process.on(name, listener);
  }

  registry.hooks = {
    remove() {
      process.off("exit", onExit);
      for (const [name, listener] of signalListeners) {
        process.off(name, listener);
      }

      registry.hooks = undefined;
    },
  };
}

/** Register a spawned run until the returned function is called with its groups ended. */
function track(run) {
  let markEnded;
  run.ended = new Promise(resolve => {
    markEnded = resolve;
  });

  registry.runs.add(run);
  installHostHooks();

  return () => {
    registry.runs.delete(run);
    if (registry.runs.size === 0) {
      registry.hooks?.remove();
    }

    markEnded();
  };
}

/**
 * A private file (0700 directory in the real temporary directory, where process.js expects it) where the child's
 * process.js records the process groups that runProcess starts, so the run can end them even when the child cannot.
 * The groups read just before the file is removed stay known, and its path is never read again. Without a usable
 * temporary directory the run goes ahead without a record, and the child ends those groups itself as before.
 */
function createGroupRecord() {
  if (!OWN_PROCESS_GROUP) {
    return undefined;
  }

  let directory;
  try {
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "useful-skills-run-"));
  } catch {
    return undefined;
  }

  const file = path.join(directory, "process-groups");
  let groups = new Set();
  let removed = false;

  // Once removed, the path is never read again: in a shared temporary directory another user could recreate it.
  const refresh = () => {
    if (!removed) {
      groups = recordedProcessGroups(file) ?? groups;
    }
  };

  return {
    file,
    signal(name) {
      refresh();
      for (const group of groups) {
        try {
          process.kill(-group, name);
        } catch {
          // The group has already ended.
        }
      }
    },
    remove() {
      if (removed) {
        return;
      }

      refresh();
      removed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function spawnFailure(error, cwd) {
  if (error.code === "ENOENT") {
    // A missing working directory reports the same spawn error as a missing executable.
    return cwd && !existsSync(cwd) ? new Error("The working directory does not exist.") : new NodeUnavailable();
  }

  return new Error("The subprocess could not run.");
}

/**
 * Run `node <script> ...args` without a shell and resolve with its exit code and output.
 * Uses `node` from PATH, never process.execPath: inside OpenCode that is the Bun-based opencode binary.
 * The child runs in its own process group, which is ended when it exits, times out, overflows, is stopped
 * through `signal` or terminateAll, or the host exits or is signalled. So are the separate groups that its
 * process.js runProcess starts, which it records for the run. A process that leaves the group but keeps the
 * output open delays the result by at most a second. Rejects with NodeUnavailable when Node.js is missing, and
 * with an Error on timeout, output over `maxBytes` per stream, an aborted `signal`, or another spawn failure.
 * A nonzero exit is a result.
 */
export function runNode(script, args = [], { cwd, timeoutMs, maxBytes = DEFAULT_MAX_BYTES, env, signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(stoppedError());
  }

  return new Promise((resolve, reject) => {
    const groups = createGroupRecord();
    let child;
    try {
      child = spawn("node", [script, ...args], {
        cwd,
        env: groups ? { ...(env ?? process.env), [PROCESS_GROUPS_FILE]: groups.file } : env,
        detached: OWN_PROCESS_GROUP,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      groups?.remove();
      throw error;
    }

    let failure;
    let settled = false;
    let drainTimer;
    let untrack = () => {};
    const output = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };

    const run = {
      stop: (error = stoppedError()) => {
        if (failure) {
          return;
        }

        failure = error;
        terminateGroups(run);
      },
      signal: name => {
        signalProcessTree(child, name);
        groups?.signal(name);
      },
      release: () => groups?.remove(),
    };

    const onAbort = () => run.stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = timeoutMs > 0
      ? setTimeout(() => run.stop(new Error(`The subprocess did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
      : undefined;

    // Once the child has exited normally its result stands; neither may turn it into a failure while output drains.
    const stopWatching = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = exitSignal => {
      if (settled) {
        return;
      }

      settled = true;
      stopWatching();
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      run.release();
      untrack();

      if (failure) {
        reject(failure);
        return;
      }

      if (exitSignal) {
        reject(new Error("The subprocess could not run."));
        return;
      }

      const text = stream => Buffer.concat(output[stream]).toString("utf8");
      resolve({ exitCode: child.exitCode, stdout: text("stdout"), stderr: text("stderr") });
    };

    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", chunk => {
        bytes[stream] += chunk.length;
        if (bytes[stream] > maxBytes) {
          run.stop(new Error("The subprocess output exceeded its size limit."));
          return;
        }

        output[stream].push(chunk);
      });
    }

    child.once("spawn", () => {
      untrack = track(run);
    });

    child.once("error", error => {
      failure ??= spawnFailure(error, cwd);
      finish();
    });

    child.once("exit", (code, exitSignal) => {
      if (failure) {
        // The child is gone, so whatever is left of its groups gets no further grace, and its output is not needed.
        run.signal("SIGKILL");
        finish(exitSignal);
        return;
      }

      // A normal exit still ends grandchildren that were left running, and waits only briefly for the rest of
      // the output when a process outside the group holds it open.
      stopWatching();
      terminateGroups(run);
      drainTimer = setTimeout(() => finish(exitSignal), OUTPUT_DRAIN_MS);
    });

    child.once("close", (code, exitSignal) => finish(exitSignal));
  });
}

/**
 * Subprocess runs that end together, as one plugin instance's do. `run` takes runNode's arguments;
 * `terminate()` stops this scope's running subprocesses, refuses new ones, and resolves once their process
 * groups are ended. Other scopes in the same process keep running.
 */
export function createRunScope() {
  const stopped = new AbortController();
  const pending = new Set();

  function run(script, args, options = {}) {
    const result = runNode(script, args, { ...options, signal: stopped.signal });
    const forget = () => pending.delete(result);
    pending.add(result);
    result.then(forget, forget);
    return result;
  }

  async function terminate() {
    stopped.abort();
    await Promise.allSettled([...pending]);
  }

  return { run, terminate };
}
