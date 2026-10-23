import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
// Shorter than the grace opencode/node-runner.js gives this process, so children end before it is killed.
const ENTRY_TERMINATION_GRACE_MS = 100;

function requiredPath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }

  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }

  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }

  return value;
}

export function minimalEnvironment({ home, cache, tmp, pathEntries = [] }) {
  const entries = pathEntries.map((entry) => requiredPath(entry, "pathEntries entry"));

  return Object.freeze({
    HOME: requiredPath(home, "home"),
    PATH: entries.join(path.delimiter),
    TMPDIR: requiredPath(tmp, "tmp"),
    UV_CACHE_DIR: requiredPath(cache, "cache"),
  });
}

function processError(message, details = {}) {
  return Object.assign(new Error(message), details);
}

/** Signal a child spawned detached into its own process group, falling back to the child alone. */
export function signalProcessTree(child, signal) {
  if (!child.pid) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A process group can disappear before its child emits close.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The close/error handler reports the original process failure.
  }
}

/**
 * Set only by opencode/node-runner.js: the private file in which this process records the process group of each
 * running runProcess child. The runner ends those groups itself, so they do not outlive this process even when it
 * is too busy to handle the runner's SIGTERM. Each line is `+<pgid>` when a child starts or `-<pgid>` when it closes.
 */
export const PROCESS_GROUPS_FILE = "USEFUL_SKILLS_PROCESS_GROUPS_FILE";

// A record never grows past this, so reading it stays cheap; groups started after it fills are not recorded.
const RECORD_MAX_BYTES = 64 * 1024;
const RECORD_LINE = /^[+-][1-9]\d*$/;
const RUN_DIRECTORY_PREFIX = "useful-skills-run-";
const RECORD_NAME = "process-groups";

/**
 * Whether `file` is where the runner records a run: `process-groups` in a `useful-skills-run-*` directory directly
 * in the real temporary directory, which is a real directory that this user owns and only this user can enter.
 * Anything else, such as a path that a script set for itself or a symlink, is ignored.
 */
function isRunRecord(file) {
  if (typeof file !== "string" || typeof process.getuid !== "function") {
    return false;
  }

  const directoryName = path.basename(path.dirname(file));
  if (!directoryName.startsWith(RUN_DIRECTORY_PREFIX) || directoryName === RUN_DIRECTORY_PREFIX) {
    return false;
  }

  try {
    const directory = path.join(realpathSync(os.tmpdir()), directoryName);
    if (file !== path.join(directory, RECORD_NAME)) {
      return false;
    }

    const stats = lstatSync(directory);
    return stats.isDirectory() && stats.uid === process.getuid() && (stats.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function recordProcessGroup(change, child) {
  const file = process.env[PROCESS_GROUPS_FILE];
  if (!file || !child.pid || process.platform === "win32" || !isRunRecord(file)) {
    return;
  }

  const line = `${change}${child.pid}\n`;
  let descriptor;
  try {
    // Never follows a symlink, and never waits on a FIFO put in its place.
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    descriptor = openSync(file, flags, 0o600);

    const stats = fstatSync(descriptor);
    if (stats.isFile() && stats.size + line.length <= RECORD_MAX_BYTES) {
      writeSync(descriptor, line);
    }
  } catch {
    // The runner removed the file once it no longer needs it.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** The process group of this process, where /proc reports it. */
function ownProcessGroup() {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    // After the parenthesized command name: state, parent pid, process group.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return undefined;
  }
}

/** Whether `stats` belong to this user, where the platform reports one (not on Windows). */
function ownedByThisUser(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

/**
 * Up to RECORD_MAX_BYTES of a regular file that this user owns, in a real directory that this user owns and only
 * this user can enter, without following a symlink or waiting on a FIFO; undefined otherwise. Another user can
 * create neither, even where the runner has removed its own.
 */
function readRecord(file) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    const stats = fstatSync(descriptor);
    if (!stats.isFile() || !ownedByThisUser(stats) || stats.size > RECORD_MAX_BYTES) {
      return undefined;
    }

    const directory = lstatSync(path.dirname(file));
    if (!directory.isDirectory() || !ownedByThisUser(directory) || (directory.mode & 0o777) !== 0o700) {
      return undefined;
    }

    const buffer = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let length = 0;
    let read;
    do {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    } while (read > 0 && length < buffer.length);

    return length > RECORD_MAX_BYTES ? undefined : buffer.toString("utf8", 0, length);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/**
 * The process groups that `file` (see PROCESS_GROUPS_FILE) records as still running, or undefined if it cannot be
 * read. Malformed lines are skipped, and so are this process's own group and its pid, which a script could write
 * there to have the runner signal its host.
 */
export function recordedProcessGroups(file) {
  const text = readRecord(file);
  if (text === undefined) {
    return undefined;
  }

  const excluded = new Set([process.pid, ownProcessGroup()]);
  const groups = new Set();
  for (const line of text.split("\n")) {
    if (!RECORD_LINE.test(line)) {
      continue;
    }

    // 1 (and 0, which the pattern rejects) would signal every process or this process's own group.
    const group = Number(line.slice(1));
    if (!Number.isSafeInteger(group) || group <= 1 || excluded.has(group)) {
      continue;
    }

    if (line.startsWith("+")) {
      groups.add(group);
    } else {
      groups.delete(group);
    }
  }

  return groups;
}

// runProcess children still running. Each is its own process group, so a signal to the parent does not reach it.
const activeChildren = new Set();
const terminationCleanups = new Set();

/** Signal the process group of every runProcess child that has not closed yet. */
export function terminateActiveProcesses(signal) {
  for (const child of activeChildren) {
    signalProcessTree(child, signal);
  }
}

/**
 * Run `cleanup` synchronously if exitOnTermination ends this process. Call the returned function once the
 * cleanup is no longer needed.
 */
export function onTermination(cleanup) {
  terminationCleanups.add(cleanup);
  return () => terminationCleanups.delete(cleanup);
}

function runTerminationCleanups() {
  for (const cleanup of terminationCleanups) {
    try {
      cleanup();
    } catch {
      // The process is exiting; one failed cleanup must not skip the others.
    }
  }
}

/**
 * For a command-line entry point only: on SIGTERM, SIGHUP, or SIGINT, end the process groups of running
 * runProcess children (SIGTERM, then SIGKILL after a short grace), run the onTermination cleanups, and exit
 * with 128 + the signal number. Without it those children would outlive the entry point.
 */
export function exitOnTermination() {
  let terminating = false;

  for (const name of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(name, () => {
      if (terminating) {
        return;
      }

      terminating = true;
      terminateActiveProcesses("SIGTERM");

      const grace = activeChildren.size > 0 ? ENTRY_TERMINATION_GRACE_MS : 0;
      setTimeout(() => {
        terminateActiveProcesses("SIGKILL");
        runTerminationCleanups();
        process.exit(128 + os.constants.signals[name]);
      }, grace);
    });
  }
}

/** Run a command without a shell and bound both output streams. */
export function runProcess(file, args, options) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new TypeError("file must be an absolute path.");
  }

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new TypeError("args must be an array of strings.");
  }

  if (!options || typeof options !== "object") {
    throw new TypeError("Process options are required.");
  }

  const cwd = requiredPath(options.cwd, "cwd");
  const timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs");
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");

  if (!options.env || typeof options.env !== "object") {
    throw new TypeError("env must be an object.");
  }

  if (options.inheritedFds !== undefined && !Array.isArray(options.inheritedFds)) {
    throw new TypeError("inheritedFds must be an array.");
  }

  const inheritedFds = (options.inheritedFds ?? []).map((descriptor) => nonnegativeInteger(descriptor, "inheritedFds entry"));

  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }

  if (options.signal?.aborted) {
    return Promise.reject(processError("Process cancelled.", { cause: options.signal.reason }));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let failure;
    let terminating = false;
    let escalation;
    let completion;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const environment = { ...options.env, NODE_V8_COVERAGE: "" };
    delete environment[PROCESS_GROUPS_FILE];

    const child = spawn(file, args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", ...inheritedFds],
      windowsHide: true,
    });

    activeChildren.add(child);
    recordProcessGroup("+", child);

    const forget = () => {
      activeChildren.delete(child);
      recordProcessGroup("-", child);
    };

    const finish = (error, result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      clearTimeout(completion);
      options.signal?.removeEventListener("abort", onAbort);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const terminate = () => {
      if (terminating) {
        return;
      }

      terminating = true;
      signalProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        escalation = undefined;
      }, TERMINATION_GRACE_MS);
    };

    const trackOutputBytes = (stream, chunk) => {
      const bytes = stream === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;

      if (stream === "stdout") {
        stdoutBytes = bytes;
      } else {
        stderrBytes = bytes;
      }

      if (bytes > maxBytes && !failure) {
        failure = processError(`Process ${stream} output exceeded ${maxBytes} bytes.`);
        terminate();
      }
    };

    const onAbort = () => {
      if (!failure) {
        failure = processError("Process cancelled.", { cause: options.signal.reason });
      }

      terminate();
    };

    const timeout = setTimeout(() => {
      if (!failure) {
        failure = processError(`Process timed out after ${timeoutMs}ms.`);
      }

      terminate();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      trackOutputBytes("stdout", chunk);

      if (!failure) {
        stdout.push(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      trackOutputBytes("stderr", chunk);

      if (!failure) {
        stderr.push(chunk);
      }
    });

    child.once("error", (error) => {
      forget();
      clearTimeout(escalation);
      finish(processError(`Cannot start process: ${error.message}`, { cause: error }));
    });

    child.once("close", (code, closeSignal) => {
      forget();

      if (failure) {
        if (!terminating) {
          return finish(failure);
        }

        completion = setTimeout(() => finish(failure), TERMINATION_GRACE_MS + 10);
        return;
      }

      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) {
        return finish(undefined, result);
      }

      return finish(processError(`Process exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}.`, {
        ...result,
        exitCode: code ?? null,
        signal: closeSignal ?? null,
      }));
    });

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
