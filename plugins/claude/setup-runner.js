import path from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT = "/usr/bin/timeout";
const KILL_AFTER = "1s";
const TERMINATION_GRACE_MS = 1_100;
const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "setup-watchdog.js");

function timeoutDuration(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer.");
  }

  return `${timeoutMs / 1_000}s`;
}

/** Keep setup writers bounded and holding the parent lock if their coordinator dies. */
export function createLockedRunner(run, lease, { platform = process.platform } = {}) {
  if (typeof run !== "function") {
    throw new TypeError("run must be a function.");
  }

  if (!Number.isSafeInteger(lease?.fd) || lease.fd < 0) {
    throw new TypeError("lease must contain a nonnegative safe file descriptor.");
  }

  const descriptor = lease.fd;

  return (file, args, options) => {
    const duration = timeoutDuration(options?.timeoutMs);
    const darwin = platform === "darwin";
    const runner = darwin ? process.execPath : TIMEOUT;
    const runnerArgs = darwin
      ? [WATCHDOG, String(options.timeoutMs), file, ...args]
      : [`--kill-after=${KILL_AFTER}`, duration, file, ...args];

    return run(runner, runnerArgs, {
      ...options,
      inheritedFds: [descriptor],
      timeoutMs: options.timeoutMs + TERMINATION_GRACE_MS,
    });
  };
}
