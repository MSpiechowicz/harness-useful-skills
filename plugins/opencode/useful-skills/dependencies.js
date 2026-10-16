import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { archiveEntries, platformKey, validateManifest } from "./dependency-policy.js";
import { download, throwIfAborted } from "./dependency-transport.js";
import { isPathWithin } from "./path-boundary.js";
import { minimalEnvironment, runProcess } from "./process.js";
import { acquireSetupLock } from "./setup-lock.js";
import { createLockedRunner } from "./setup-runner.js";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEPENDENCIES_ROOT = path.join(PACKAGE_ROOT, "dependencies");
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_MAX_BYTES = 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredAgentDir(agentDir) {
  if (typeof agentDir !== "string" || !agentDir) {
    throw new TypeError("agentDir must be a non-empty path.");
  }

  return path.resolve(agentDir);
}

function dependencyDirectory(agentDir) {
  return path.join(requiredAgentDir(agentDir), "useful-skills", "dependencies");
}

function environment(root) {
  return minimalEnvironment({
    home: path.join(root, "home"),
    cache: path.join(root, "cache"),
    tmp: path.join(root, "tmp"),
    pathEntries: ["/usr/bin", "/bin"],
  });
}

async function fileExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function regularFile(file) {
  try {
    const entry = await lstat(file);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function createDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const onAbort = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error("Dependency setup was cancelled."));
  const onTimeout = () => controller.abort(new Error(`Dependency setup timed out after ${timeoutMs}ms.`));
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      signal?.removeEventListener("abort", onAbort);
      timeoutSignal.removeEventListener("abort", onTimeout);
    },
  };
}

async function privateDirectory(parent, name, create) {
  const target = path.join(parent, name);
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) {
      throw error;
    }

    try {
      await mkdir(target, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") {
        throw mkdirError;
      }
    }

    entry = await lstat(target);
  }

  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Profile-owned dependency path ${target} must be a directory, not a symlink.`);
  }

  await chmod(target, 0o700);
  const resolved = await realpath(target);
  if (resolved !== target) {
    throw new Error(`Profile-owned dependency path ${target} resolves outside storage.`);
  }

  return target;
}

async function storageDirectory(agentDir, create) {
  const profile = requiredAgentDir(agentDir);
  if (create) {
    await mkdir(profile, { recursive: true, mode: 0o700 });
  }

  const profileEntry = await lstat(profile);
  if (!profileEntry.isDirectory() || profileEntry.isSymbolicLink()) {
    throw new Error("The agent profile directory must be a real directory.");
  }

  const resolvedProfile = await realpath(profile);
  return privateDirectory(await privateDirectory(resolvedProfile, "useful-skills", create), "dependencies", create);
}

async function readMarker(root) {
  const marker = path.join(root, "installation.json");
  if (!await regularFile(marker)) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(marker, "utf8"));
  } catch {
    return undefined;
  }
}

// Retain the original Linux-only cache identity after adding Darwin metadata.
function cacheManifestBytes(manifestBytes, manifest, platform) {
  if (platform !== "linux-x64" || !manifest.uv.platforms["darwin-arm64"]) {
    return manifestBytes;
  }

  delete manifest.uv.platforms["darwin-arm64"];
  delete manifest.python.platforms["darwin-arm64"];
  const indent = manifestBytes.toString("utf8").match(/\n([ \t]+)"schemaVersion"/)?.[1] ?? "";
  return Buffer.from(JSON.stringify(manifest, null, indent) + (manifestBytes.at(-1) === 10 ? "\n" : ""));
}

export function createDependencyManager({
  dependenciesRoot = DEPENDENCIES_ROOT,
  fetch: fetcher = globalThis.fetch,
  run = runProcess,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (typeof fetcher !== "function" || typeof run !== "function") {
    throw new TypeError("Dependency transport and process runner must be functions.");
  }

  if (typeof platform !== "string" || typeof arch !== "string") {
    throw new TypeError("platform and arch must be strings.");
  }

  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs <= 0) {
    throw new TypeError("setupTimeoutMs must be a positive safe integer.");
  }

  async function layout(agentDir) {
    const [manifestBytes, lock] = await Promise.all([
      readFile(path.join(dependenciesRoot, "manifest.json")),
      readFile(path.join(dependenciesRoot, "graphify.lock")),
    ]);

    const manifest = JSON.parse(manifestBytes);
    const metadata = validateManifest(manifest, platform, arch);
    const cacheManifest = cacheManifestBytes(manifestBytes, manifest, metadata.key);
    const lockHash = hash(Buffer.concat([cacheManifest, Buffer.from([0]), lock]));

    const root = dependencyDirectory(agentDir);
    const versionRoot = path.join(root, lockHash);
    return {
      lock,
      lockHash,
      metadata,
      root,
      versionRoot,
      python: path.join(versionRoot, "venv", "bin", "python"),
    };
  }

  async function installationHealthy(state, signal) {
    throwIfAborted(signal);
    try {
      const rootEntry = await lstat(state.versionRoot);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
        return false;
      }

      const realRoot = await realpath(state.versionRoot);
      if (realRoot !== state.versionRoot) {
        return false;
      }

      const realPython = await realpath(state.python);
      if (!isPathWithin(realRoot, realPython)) {
        return false;
      }

      const version = await run(state.python, ["--version"], {
        cwd: state.versionRoot,
        env: environment(state.versionRoot),
        signal,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });
      if (version.stdout.trim() !== "Python 3.12.14") {
        return false;
      }

      const graphify = await run(state.python, [
        "-I",
        "-B",
        "-c",
        "import graphify; import importlib.metadata as m; print(m.version('graphifyy'))",
      ], {
        cwd: state.versionRoot,
        env: environment(state.versionRoot),
        signal,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });
      return graphify.stdout.trim() === state.metadata.graphify.version;
    } catch (error) {
      if (signal?.aborted) {
        throwIfAborted(signal);
      }

      return false;
    }
  }

  async function ready(state, signal) {
    const installed = await readMarker(state.versionRoot);
    return Boolean(
      installed
      && installed.lockHash === state.lockHash
      && installed.version === state.metadata.graphify.version
      && await installationHealthy(state, signal),
    );
  }

  async function runTar(stage, archive, signal) {
    const result = await run("/usr/bin/tar", ["-tvzf", archive], {
      cwd: stage,
      env: environment(stage),
      signal,
      timeoutMs: 30_000,
      maxBytes: COMMAND_MAX_BYTES,
    });
    return archiveEntries(result.stdout, platform);
  }

  async function build(state, signal, lease) {
    const runLocked = createLockedRunner(run, lease, { platform });
    const stage = await mkdtemp(path.join(state.root, `.setup-${state.lockHash}-`));
    const stageEnvironment = environment(stage);
    let versionCreated = false;
    try {
      await Promise.all([
        chmod(stage, 0o700),
        mkdir(stageEnvironment.HOME, { mode: 0o700 }),
        mkdir(stageEnvironment.UV_CACHE_DIR, { mode: 0o700 }),
        mkdir(stageEnvironment.TMPDIR, { mode: 0o700 }),
      ]);

      const uvArchive = path.join(stage, "uv.tar.gz");
      await download(state.metadata.uv.url, state.metadata.uv.sha256, uvArchive, signal, fetcher);
      const entries = await runTar(stage, uvArchive, signal);
      if (!entries.some((entry) => entry.type === "-" && entry.name === state.metadata.uv.executable)) {
        throw new Error("Dependency archive did not contain the pinned uv executable.");
      }

      await runLocked("/usr/bin/tar", platform === "darwin"
        ? ["-xozf", uvArchive]
        : ["-xzf", uvArchive, "--no-same-owner", "--no-same-permissions"], {
        cwd: stage,
        env: stageEnvironment,
        signal,
        timeoutMs: 30_000,
        maxBytes: COMMAND_MAX_BYTES,
      });

      const uv = path.join(stage, state.metadata.uv.executable);
      const uvEntry = await lstat(uv);
      if (!uvEntry.isFile() || uvEntry.isSymbolicLink() || !isPathWithin(stage, await realpath(uv))) {
        throw new Error("Dependency archive did not safely extract the pinned uv executable.");
      }

      const uvVersion = await run(uv, ["--version"], {
        cwd: stage,
        env: stageEnvironment,
        signal,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });

      const uvVersionMatch = /^uv 0\.12\.17 \((?:[0-9a-fA-F]+ [0-9]{4}-[0-9]{2}-[0-9]{2} )?(aarch64-apple-darwin|x86_64-unknown-linux-gnu)\)(?:\r?\n)?(?![\s\S])/.exec(uvVersion.stdout);
      if (uvVersionMatch?.[1] !== (platform === "darwin" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu")) {
        throw new Error("Downloaded uv version did not match committed metadata.");
      }

      const pythonArchive = path.join(stage, "python.tar.gz");
      await download(state.metadata.python.url, state.metadata.python.sha256, pythonArchive, signal, fetcher);
      const mirror = path.join(stage, "python-mirror");
      await mkdir(path.join(mirror, state.metadata.python.build), { recursive: true, mode: 0o700 });
      await copyFile(pythonArchive, path.join(mirror, state.metadata.python.build, state.metadata.python.archive));

      await rm(state.versionRoot, { recursive: true, force: true });
      await mkdir(state.versionRoot, { mode: 0o700 });
      versionCreated = true;
      const versionEnvironment = environment(state.versionRoot);
      await Promise.all([
        mkdir(versionEnvironment.HOME, { mode: 0o700 }),
        mkdir(versionEnvironment.UV_CACHE_DIR, { mode: 0o700 }),
        mkdir(versionEnvironment.TMPDIR, { mode: 0o700 }),
      ]);

      await runLocked(uv, [
        "--no-config", "python", "install", "cpython-3.12.14", "--no-bin", "--no-registry",
        "--install-dir", path.join(state.versionRoot, "python"),
      ], {
        cwd: state.versionRoot,
        env: { ...versionEnvironment, UV_PYTHON_INSTALL_MIRROR: pathToFileURL(`${mirror}${path.sep}`).href },
        signal,
        timeoutMs: setupTimeoutMs,
        maxBytes: COMMAND_MAX_BYTES,
      });

      const pythonEntries = await readdir(path.join(state.versionRoot, "python"), { withFileTypes: true });
      const pythonEntry = pythonEntries.find((entry) => entry.isDirectory() && entry.name.startsWith("cpython-3.12.14-"));
      if (!pythonEntry) {
        throw new Error("Managed CPython installation did not produce Python 3.12.14.");
      }

      const managedPython = path.join(state.versionRoot, "python", pythonEntry.name, "bin", "python3.12");
      await runLocked(uv, ["--no-config", "venv", "--python", managedPython, path.join(state.versionRoot, "venv")], {
        cwd: state.versionRoot,
        env: versionEnvironment,
        signal,
        timeoutMs: 60_000,
        maxBytes: COMMAND_MAX_BYTES,
      });

      await runLocked(uv, [
        "--no-config", "pip", "sync", "--python", state.python, "--require-hashes", "--only-binary", ":all:",
        path.join(dependenciesRoot, "graphify.lock"),
      ], {
        cwd: state.versionRoot,
        env: versionEnvironment,
        signal,
        timeoutMs: setupTimeoutMs,
        maxBytes: COMMAND_MAX_BYTES,
      });

      if (!await installationHealthy(state, signal)) {
        throw new Error("Managed Graphify installation did not pass exact interpreter and package checks.");
      }

      await writeFile(path.join(state.versionRoot, "installation.json"), JSON.stringify({
        lockHash: state.lockHash,
        version: state.metadata.graphify.version,
      }), { mode: 0o600 });
    } catch (error) {
      if (versionCreated) {
        await rm(state.versionRoot, { recursive: true, force: true });
      }

      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function status({ agentDir } = {}) {
    const key = platformKey(platform, arch);
    if (!key) {
      return {
        ready: false,
        state: "unsupported",
        platform: `${platform}-${arch}`,
        reason: "Only linux-x64 and darwin-arm64 have validated managed downloads.",
      };
    }

    const state = await layout(agentDir);
    const present = await fileExists(state.versionRoot);
    const isReady = present && await ready(state);

    return {
      ready: isReady,
      state: present ? (isReady ? "ready" : "partial") : "missing",
      platform: state.metadata.key,
      versionRoot: state.versionRoot,
      version: state.metadata.graphify.version,
      lockHash: state.lockHash,
      python: state.python,
    };
  }

  async function ensure({ agentDir, signal } = {}) {
    if (!platformKey(platform, arch)) {
      throw new Error(`Managed Graphify setup is unsupported on ${platform}/${arch}.`);
    }

    const deadline = createDeadline(signal, setupTimeoutMs);
    let lease;
    try {
      throwIfAborted(deadline.signal);
      const root = await storageDirectory(agentDir, true);
      const state = await layout(agentDir);

      if (root !== state.root) {
        throw new Error("Profile-owned dependency storage resolves outside the expected location.");
      }

      if (await ready(state, deadline.signal)) {
        return {
          python: state.python,
          versionRoot: state.versionRoot,
          version: state.metadata.graphify.version,
          lockHash: state.lockHash,
        };
      }

      lease = await acquireSetupLock(path.join(root, ".setup.lock"), {
        signal: deadline.signal,
        timeoutMs: setupTimeoutMs,
        platform,
        run,
      });
      if (!await ready(state, deadline.signal)) {
        await build(state, deadline.signal, lease);
      }

      if (!await ready(state, deadline.signal)) {
        throw new Error("Managed Graphify installation did not activate.");
      }

      return {
        python: state.python,
        versionRoot: state.versionRoot,
        version: state.metadata.graphify.version,
        lockHash: state.lockHash,
      };
    } finally {
      await lease?.release();
      deadline.dispose();
    }
  }

  return Object.freeze({ ensure, status });
}

const defaultManager = createDependencyManager();

/** Inspect only; this function never creates profile directories or installs software. */
export async function dependencyStatus(options = {}) {
  return defaultManager.status(options);
}

export async function ensureDependencies(options = {}) {
  return defaultManager.ensure(options);
}
