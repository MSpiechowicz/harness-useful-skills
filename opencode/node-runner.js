import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { signalProcessTree } from "../process.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const OWN_PROCESS_GROUP = process.platform !== "win32";
const HOST_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];

// Subprocesses still running, each with its `stop(error)` and a promise that settles once its group is ended.
const running = new Map();
let hostHooksInstalled = false;

/** Node.js is not on PATH, so no Useful Skills subprocess can run. */
export class NodeUnavailable extends Error {
  constructor() {
    super("Node.js is not available on PATH.");
    this.name = "NodeUnavailable";
  }
}

/** SIGTERM the child's group now and SIGKILL whatever is left after a short grace period. */
function terminateGroup(child) {
  signalProcessTree(child, "SIGTERM");
  setTimeout(() => signalProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS).unref();
}

function stoppedError() {
  return new Error("The subprocess was stopped.");
}

/** Stop every running subprocess and resolve once each one's process group has been ended. */
export async function terminateAll() {
  const runs = [...running.values()];
  for (const { stop } of runs) {
    stop(stoppedError());
  }

  await Promise.allSettled(runs.map(({ ended }) => ended));
}

/**
 * When the host is killed by a signal it handles nowhere else, end the subprocesses first, then let the signal
 * take its default effect. The host's own signal handling always wins.
 */
function forwardHostSignal(name) {
  const listener = async () => {
    // A listener added since belongs to the host, which decides what this signal does.
    if (process.listenerCount(name) > 1) {
      return;
    }

    process.off(name, listener);
    await terminateAll();
    process.kill(process.pid, name);
  };

  process.on(name, listener);
}

function installHostHooks() {
  if (hostHooksInstalled) {
    return;
  }

  hostHooksInstalled = true;

  // Nothing can wait during exit. SIGTERM, unlike SIGKILL, lets a Useful Skills script end its own
  // separately grouped children before it exits (process.js exitOnTermination).
  process.once("exit", () => {
    for (const child of running.keys()) {
      signalProcessTree(child, "SIGTERM");
    }
  });

  // A Worker receives no signals, and terminating it emits no exit event: the plugin's dispose hook covers it.
  if (!isMainThread || process.platform === "win32") {
    return;
  }

  for (const name of HOST_SIGNALS) {
    if (process.listenerCount(name) === 0) {
      forwardHostSignal(name);
    }
  }
}

/** Track a spawned child until the returned function is called with its group ended. */
function track(child, stop) {
  installHostHooks();

  let markEnded;
  const ended = new Promise(resolve => {
    markEnded = resolve;
  });
  running.set(child, { stop, ended });

  return () => {
    running.delete(child);
    markEnded();
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
 * through `signal` or terminateAll, or the host exits. A grandchild that starts a process group of its own
 * (process.js runProcess does) is outside that group: it ends only when the child ends it, as the Useful
 * Skills scripts do on SIGTERM. Rejects with NodeUnavailable when Node.js is missing, and with an Error on
 * timeout, output over `maxBytes` per stream, an aborted `signal`, or another spawn failure. A nonzero exit
 * is a result.
 */
export function runNode(script, args = [], { cwd, timeoutMs, maxBytes = DEFAULT_MAX_BYTES, env, signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(stoppedError());
  }

  return new Promise((resolve, reject) => {
    const child = spawn("node", [script, ...args], {
      cwd,
      env,
      detached: OWN_PROCESS_GROUP,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let failure;
    let untrack = () => {};
    const output = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };

    const stop = error => {
      if (failure) {
        return;
      }

      failure = error;
      terminateGroup(child);
    };

    const onAbort = () => stop(stoppedError());
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = timeoutMs > 0
      ? setTimeout(() => stop(new Error(`The subprocess did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
      : undefined;

    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      untrack();
    };

    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", chunk => {
        bytes[stream] += chunk.length;
        if (bytes[stream] > maxBytes) {
          stop(new Error("The subprocess output exceeded its size limit."));
          return;
        }

        output[stream].push(chunk);
      });
    }

    child.once("spawn", () => {
      untrack = track(child, stop);
    });

    child.once("error", error => {
      settle();
      reject(failure ?? spawnFailure(error, cwd));
    });

    child.once("close", (code, exitSignal) => {
      if (failure) {
        // The child is gone, so whatever is left in its group gets no further grace.
        signalProcessTree(child, "SIGKILL");
        settle();
        reject(failure);
        return;
      }

      // A normal exit still ends grandchildren that were left running in the group.
      terminateGroup(child);
      settle();

      if (exitSignal) {
        reject(new Error("The subprocess could not run."));
        return;
      }

      const text = stream => Buffer.concat(output[stream]).toString("utf8");
      resolve({ exitCode: code, stdout: text("stdout"), stderr: text("stderr") });
    });
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
