import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minimalEnvironment, runProcess } from "./process.js";
import { acquireSetupLock } from "./setup-lock.js";
import { createLockedRunner } from "./setup-runner.js";
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEPENDENCIES_ROOT = path.join(PACKAGE_ROOT, "dependencies");
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
const COMMAND_MAX_BYTES = 1024 * 1024;
const APPROVED_DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function requiredAgentDir(agentDir) {
  if (typeof agentDir !== "string" || !agentDir) throw new TypeError("agentDir must be a non-empty path.");
  return path.resolve(agentDir);
}
function platformKey(platform, arch) {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return undefined;
}
function isApprovedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && APPROVED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value.replace(/\/$/, ""));
  return !path.posix.isAbsolute(value) && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}
function safeFileName(value) {
  return typeof value === "string" && safeArchivePath(value) && !value.includes("/");
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
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Dependency setup was cancelled.");
  }
}

async function fileExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
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

function validateManifest(value, platform, arch) {
  const key = platformKey(platform, arch);
  if (!key) throw new Error(`Managed Graphify setup is unsupported on ${platform}/${arch}.`);
  const uv = value?.uv?.platforms?.[key];
  const python = value?.python?.platforms?.[key];
  const valid = value?.schemaVersion === 1
    && value?.uv?.version === "0.12.17"
    && value?.python?.version === "3.12.14"
    && value?.python?.build === "20260901"
    && value?.graphify?.package === "graphifyy"
    && value?.graphify?.version === "0.9.65"
    && uv?.archive === "tar.gz"
    && safeArchivePath(uv?.executable)
    && isApprovedUrl(uv?.url)
    && isDigest(uv?.sha256)
    && isApprovedUrl(python?.url)
    && isApprovedUrl(python?.mirror)
    && safeFileName(python?.archive)
    && isDigest(python?.sha256)
    && value.graphify.sha256 === "e4c1ef6967d5a090b315f9b18b5255d9a0dead0c24a7620e7dffeaa443395535";
  if (!valid) throw new Error("Committed dependency metadata is invalid.");
  return Object.freeze({ ...value, key, uv: Object.freeze({ ...uv }), python: Object.freeze({ ...python, version: value.python.version, build: value.python.build }) });
}

function createDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const onAbort = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error("Dependency setup was cancelled."));
  const onTimeout = () => controller.abort(new Error(`Dependency setup timed out after ${timeoutMs}ms.`));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
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
    if (error?.code !== "ENOENT" || !create) throw error;
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    entry = await lstat(target);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Profile-owned dependency path ${target} must be a directory, not a symlink.`);
  }
  await chmod(target, 0o700);
  const resolved = await realpath(target);
  if (resolved !== target) throw new Error(`Profile-owned dependency path ${target} resolves outside storage.`);
  return target;
}

async function storageDirectory(agentDir, create) {
  const profile = requiredAgentDir(agentDir);
  if (create) await mkdir(profile, { recursive: true, mode: 0o700 });
  const profileEntry = await lstat(profile);
  if (!profileEntry.isDirectory() || profileEntry.isSymbolicLink()) {
    throw new Error("The agent profile directory must be a real directory.");
  }
  const resolvedProfile = await realpath(profile);
  return privateDirectory(await privateDirectory(resolvedProfile, "useful-skills", create), "dependencies", create);
}

async function readMarker(root) {
  const marker = path.join(root, "installation.json");
  if (!await regularFile(marker)) return undefined;
  try {
    return JSON.parse(await readFile(marker, "utf8"));
  } catch {
    return undefined;
  }
}

function archiveEntries(listing, platform) {
  const entries = [];
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const match = platform === "darwin"
      ? line.match(/^([\-dlh])[\-rwxstST]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s+(.+)$/)
      : line.match(/^([\-dlh])\S*\s+.*?\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) throw new Error("Dependency archive has an unsupported entry format.");
    const [, type, rest] = match;
    const marker = type === "l" ? " -> " : type === "h" ? " link to " : undefined;
    const [name, linkTarget] = marker ? rest.split(marker, 2) : [rest];
    if (!safeArchivePath(name)) throw new Error("Dependency archive contains an unsafe path.");
    if (marker) {
      if (!linkTarget || linkTarget.includes("\0") || path.posix.isAbsolute(linkTarget)) {
        throw new Error("Dependency archive contains an unsafe link target.");
      }
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(name), linkTarget));
      if (destination === ".." || destination.startsWith("../")) {
        throw new Error("Dependency archive contains an unsafe link target.");
      }
    }
    entries.push({ type, name });
  }
  return entries;
}

async function download(url, digest, target, signal, fetcher) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(signal);
    const response = await fetcher(current.href, { redirect: "manual", signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new Error("Dependency download exceeded the approved redirect limit.");
      current = new URL(location, current);
      if (!isApprovedUrl(current)) throw new Error("Dependency download redirected to an unapproved location.");
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Dependency download failed (HTTP ${response.status}).`);
    const output = await open(target, "wx", 0o600);
    let completed = false;
    try {
      const digestState = createHash("sha256");
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) break;
        total += next.value.length;
        if (total > DOWNLOAD_MAX_BYTES) throw new Error("Dependency download exceeded the size limit.");
        digestState.update(next.value);
        for (let offset = 0; offset < next.value.length;) {
          const written = await output.write(next.value, offset);
          offset += written.bytesWritten;
        }
      }
      if (digestState.digest("hex") !== digest) throw new Error("Dependency download checksum did not match committed metadata.");
      completed = true;
      return;
    } finally {
      await output.close();
      if (!completed) await unlink(target).catch(() => {});
    }
  }
}


export function createDependencyManager({
  dependenciesRoot = DEPENDENCIES_ROOT,
  fetch: fetcher = globalThis.fetch,
  run = runProcess,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (typeof fetcher !== "function" || typeof run !== "function") throw new TypeError("Dependency transport and process runner must be functions.");
  if (typeof platform !== "string" || typeof arch !== "string") throw new TypeError("platform and arch must be strings.");
  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs <= 0) throw new TypeError("setupTimeoutMs must be a positive safe integer.");
  async function layout(agentDir) {
    const [manifestBytes, lock] = await Promise.all([
      readFile(path.join(dependenciesRoot, "manifest.json")),
      readFile(path.join(dependenciesRoot, "graphify.lock")),
    ]);
    const metadata = validateManifest(JSON.parse(manifestBytes), platform, arch);
    // Linux's original manifest bytes are its established cache identity; adding
    // another platform's metadata must not invalidate healthy Linux installs.
    const cacheManifest = metadata.key === "linux-x64" && JSON.parse(manifestBytes).uv.platforms["darwin-arm64"]
      ? (() => {
        const linuxOnly = JSON.parse(manifestBytes);
        delete linuxOnly.uv.platforms["darwin-arm64"];
        delete linuxOnly.python.platforms["darwin-arm64"];
        const indent = manifestBytes.toString("utf8").match(/\n([ \t]+)"schemaVersion"/)?.[1] ?? "";
        return Buffer.from(JSON.stringify(linuxOnly, null, indent) + (manifestBytes.at(-1) === 10 ? "\n" : ""));
      })()
      : manifestBytes;
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
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return false;
      const realRoot = await realpath(state.versionRoot);
      if (realRoot !== state.versionRoot) return false;
      const realPython = await realpath(state.python);
      if (!inside(realRoot, realPython)) return false;
      const version = await run(state.python, ["--version"], {
        cwd: state.versionRoot,
        env: environment(state.versionRoot),
        signal,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });
      if (version.stdout.trim() !== "Python 3.12.14") return false;
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
      if (signal?.aborted) throwIfAborted(signal);
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
      if (!uvEntry.isFile() || uvEntry.isSymbolicLink() || !inside(stage, await realpath(uv))) {
        throw new Error("Dependency archive did not safely extract the pinned uv executable.");
      }
      const uvVersion = await run(uv, ["--version"], {
        cwd: stage,
        env: stageEnvironment,
        signal,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });

      if (uvVersion.stdout.trim() !== `uv 0.12.17 (${platform === "darwin" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu"})`) throw new Error("Downloaded uv version did not match committed metadata.");
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
      if (!pythonEntry) throw new Error("Managed CPython installation did not produce Python 3.12.14.");
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
      if (versionCreated) await rm(state.versionRoot, { recursive: true, force: true });
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
    if (!platformKey(platform, arch)) throw new Error(`Managed Graphify setup is unsupported on ${platform}/${arch}.`);
    const deadline = createDeadline(signal, setupTimeoutMs);
    let lease;
    try {
      throwIfAborted(deadline.signal);
      const root = await storageDirectory(agentDir, true);
      const state = await layout(agentDir);
      if (root !== state.root) throw new Error("Profile-owned dependency storage resolves outside the expected location.");
      if (await ready(state, deadline.signal)) return {
        python: state.python,
        versionRoot: state.versionRoot,
        version: state.metadata.graphify.version,
        lockHash: state.lockHash,
      };
      lease = await acquireSetupLock(path.join(root, ".setup.lock"), {
        signal: deadline.signal,
        timeoutMs: setupTimeoutMs,
        platform,
        run,
      });
      if (!await ready(state, deadline.signal)) await build(state, deadline.signal, lease);
      if (!await ready(state, deadline.signal)) throw new Error("Managed Graphify installation did not activate.");
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
