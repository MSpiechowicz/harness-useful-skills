import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

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

function signalProcessTree(child, signal) {
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

    const child = spawn(file, args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", ...inheritedFds],
      windowsHide: true,
    });

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
      clearTimeout(escalation);
      finish(processError(`Cannot start process: ${error.message}`, { cause: error }));
    });

    child.once("close", (code, closeSignal) => {
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
