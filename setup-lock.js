import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { runProcess } from "./process.js";

const FLOCK = "/usr/bin/flock";
const LOCKF = "/usr/bin/lockf";
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const LOCK_TIMEOUT_EXIT_CODE = 75;
const RUNNER_GRACE_MS = 250;

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Dependency setup was cancelled.");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function secureLockHandle(lockFile) {
  if (typeof lockFile !== "string" || !path.isAbsolute(lockFile)) {
    throw new TypeError("lockFile must be an absolute path.");
  }
  const parent = path.dirname(lockFile);
  const parentEntry = await lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("Dependency setup lock parent must be a real directory.");
  }

  let handle;
  try {
    handle = await open(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "EISDIR") {
      throw new Error("Dependency setup lock must be a regular file, not a symlink.");
    }
    throw error;
  }
  try {
    const [descriptorEntry, pathnameEntry, resolved] = await Promise.all([
      handle.stat(),
      lstat(lockFile),
      realpath(lockFile),
    ]);
    if (
      !descriptorEntry.isFile()
      || !pathnameEntry.isFile()
      || pathnameEntry.isSymbolicLink()
      || !sameFile(descriptorEntry, pathnameEntry)
      || resolved !== lockFile
    ) {
      throw new Error("Dependency setup lock must be a regular file, not a symlink.");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Acquire an OS-owned exclusive setup lock that child writers may inherit as fd 3. */
export async function acquireSetupLock(lockFile, { signal, timeoutMs = LOCK_WAIT_TIMEOUT_MS, platform = process.platform, run = runProcess } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
  if (typeof run !== "function") throw new TypeError("run must be a function.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer.");
  }
  const lockTimeoutMs = Math.min(timeoutMs, LOCK_WAIT_TIMEOUT_MS);
  throwIfAborted(signal);
  const handle = await secureLockHandle(lockFile);
  try {
    throwIfAborted(signal);
    await run(platform === "darwin" ? LOCKF : FLOCK, platform === "darwin"
      ? ["-s", "-t", String(Math.ceil(lockTimeoutMs / 1_000)), "3"]
      : [
        "--exclusive",
        "--timeout", String(lockTimeoutMs / 1_000),
        "--conflict-exit-code", String(LOCK_TIMEOUT_EXIT_CODE),
        "3",
      ], {
      cwd: path.dirname(lockFile),
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      signal,
      timeoutMs: lockTimeoutMs + RUNNER_GRACE_MS,
      maxBytes: 4_096,
      inheritedFds: [handle.fd],
    });
  } catch (error) {
    await handle.close();
    throwIfAborted(signal);
    if (error?.exitCode === LOCK_TIMEOUT_EXIT_CODE || (
      platform === "darwin" && error?.message === `Process timed out after ${lockTimeoutMs + RUNNER_GRACE_MS}ms.`
    )) {
      throw new Error(`Dependency setup lock acquisition timed out after ${lockTimeoutMs}ms.`);
    }
    throw error;
  }

  const fd = handle.fd;
  let closed;
  const release = () => {
    if (!closed) closed = handle.close();
    return closed;
  };
  return Object.freeze({ fd, release });
}
