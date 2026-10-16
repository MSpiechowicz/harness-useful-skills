/**
 * Update an installed OpenCode copy of Useful Skills to the latest stable GitHub release.
 *
 * The release source tarball is downloaded from GitHub only, checked entry by entry before extraction, extracted into
 * a private temporary directory, verified to be the announced version, and installed by running that release's own
 * `useful-skills install --host opencode`. Source checkouts are never overwritten; the temporary directory is always
 * removed.
 */
import { execFile } from "node:child_process";
import { createReadStream, realpathSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import { onTermination } from "../process.js";
import { REPOSITORY, UpdateError, githubToken, isNewerVersion, latestRelease, usableToken } from "../release-check.js";
import { RUNTIME_ROOT, bundleVersion, runtimeInstall, scopeRootFor } from "./paths.js";

const execFileAsync = promisify(execFile);

const NOT_INSTALLED = "This useful-skills copy is not an installed OpenCode copy; source checkouts are never overwritten.";
const NO_NEWER_RELEASE = "No newer stable release is available.";

const DOWNLOAD_HOSTS = new Set(["codeload.github.com", "github.com", "api.github.com"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_NAME = 4096;
const MAX_TAR_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLER_OUTPUT_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TAR_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;

/** Files a release must ship for its installer to set up OpenCode. */
const REQUIRED_FILES = ["useful-skills", "plugins/opencode/useful-skills.js"];
const VERSIONED_MANIFESTS = ["package.json", "plugins/opencode/useful-skills/package.json"];

const errorText = (error) => (error instanceof Error ? error.message : String(error));
const quoted = (name) => JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}...` : name);

async function execRunner(file, args, { cwd, timeoutMs, env }) {
  const { stdout } = await execFileAsync(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_INSTALLER_OUTPUT_BYTES, windowsHide: true });
  return String(stdout);
}

async function execTar(args, { timeoutMs, env }) {
  const { stdout } = await execFileAsync("tar", args, { env, timeout: timeoutMs, maxBuffer: MAX_TAR_OUTPUT_BYTES, windowsHide: true });
  return String(stdout);
}

function updateOptions(options) {
  if (!options || typeof options !== "object") {
    throw new UpdateError("Update options must be an object.");
  }

  for (const name of ["fetcher", "token", "runner", "tar"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new UpdateError(`Update ${name} must be a function.`);
    }
  }

  const environment = options.environment ?? process.env;
  return {
    environment,
    runtimeRoot: path.resolve(options.runtimeRoot ?? RUNTIME_ROOT),
    fetcher: options.fetcher ?? fetch,
    token: options.token ?? (() => githubToken(environment)),
    runner: options.runner ?? execRunner,
    tar: options.tar ?? execTar,
  };
}

/** Run a synchronous paths.js read, reporting its failure as an UpdateError. */
function trusted(read) {
  try {
    return read();
  } catch (error) {
    throw new UpdateError(errorText(error));
  }
}

async function stableRelease(state) {
  return latestRelease(state.fetcher, usableToken(await state.token()));
}

function terminalCommand(scope) {
  return `./useful-skills update install --host opencode${scope === "project" ? " --scope project" : ""}`;
}

/** Compare the installed runtime with the latest stable release without changing anything. */
export async function checkOpenCodeUpdate(options = {}) {
  const state = updateOptions(options);
  const installed = trusted(() => runtimeInstall(state.runtimeRoot));
  if (!installed) {
    let currentVersion = null;
    try {
      currentVersion = bundleVersion(state.runtimeRoot);
    } catch {
      // Nothing is installed here, so there is no version to report.
    }

    return { currentVersion, latestVersion: null, updateAvailable: false, message: NOT_INSTALLED };
  }

  const currentVersion = trusted(() => bundleVersion(state.runtimeRoot));
  const release = await stableRelease(state);
  if (!release) {
    return { currentVersion, latestVersion: null, updateAvailable: false, message: `Useful Skills ${currentVersion}: No published stable GitHub release is available.` };
  }

  const updateAvailable = isNewerVersion(release.version, currentVersion);
  const message = updateAvailable
    ? `Useful Skills ${release.version} is available (installed: ${currentVersion}). Run \`/useful-skills update install\` in OpenCode or \`${terminalCommand(installed.record.scope)}\` in a terminal.`
    : `Useful Skills ${currentVersion} is up to date.`;
  return { currentVersion, latestVersion: release.version, updateAvailable, message };
}

function homeDirectory(environment) {
  return environment.HOME && path.isAbsolute(environment.HOME) ? environment.HOME : os.homedir();
}

/**
 * Where the release installer must run so it writes to the recorded scope root. Refuses when this environment would
 * resolve the scope to a different directory, so an update never lands somewhere other than the copy it replaces.
 */
function installTarget({ scopeRoot, record }, environment) {
  const scope = record.scope;
  const cwd = scope === "project" ? path.dirname(scopeRoot) : homeDirectory(environment);

  let expected;
  try {
    const root = scopeRootFor({ scope, cwd, environment });
    expected = scope === "user" ? realpathSync(root) : root;
  } catch {
    expected = undefined;
  }

  if (expected !== scopeRoot) {
    throw new UpdateError(`This environment does not resolve the OpenCode ${scope} scope to ${scopeRoot}; refusing to install the update elsewhere.`);
  }

  return { scope, cwd };
}

/** An https URL on a GitHub download host, or an UpdateError. */
function downloadUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new UpdateError("GitHub returned an invalid release download location.");
  }

  if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new UpdateError(`Refusing to download the release from ${url.protocol}//${url.host}.`);
  }

  return url.href;
}

/** Fetch the tag's source tarball, following at most a few redirects and only between GitHub download hosts. */
async function openDownload(fetcher, version) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let url = downloadUrl(`https://codeload.github.com/${REPOSITORY}/tar.gz/refs/tags/v${version}`);
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetcher(url, { headers: { "User-Agent": "harness-useful-skills-updater" }, redirect: "manual", signal });
    } catch (error) {
      throw new UpdateError(`Cannot download the release archive: ${errorText(error)}`);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (redirects >= MAX_REDIRECTS) {
      throw new UpdateError("The release download redirected too many times.");
    }

    url = downloadUrl(response.headers.get("location") ?? "", url);
  }
}

/** Stream the response body into `file`, stopping as soon as it exceeds the archive size limit. */
async function saveDownload(response, file) {
  const tooLarge = new UpdateError(`The release archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB download limit.`);
  if (!response.ok) {
    throw new UpdateError(`The release download failed (HTTP ${response.status}).`);
  }

  if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) {
    throw tooLarge;
  }

  if (!response.body) {
    throw new UpdateError("The release download was empty.");
  }

  const handle = await open(file, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        throw tooLarge;
      }

      await handle.write(chunk);
    }
  } catch (error) {
    throw error instanceof UpdateError ? error : new UpdateError(`The release download failed: ${errorText(error)}`);
  } finally {
    await handle.close();
  }

  if (total === 0) {
    throw new UpdateError("The release download was empty.");
  }
}

/** Decompress without writing anything, so a small archive cannot expand into an unbounded tree. */
async function checkExpandedSize(archive) {
  let total = 0;
  const counter = new Writable({
    write(chunk, _encoding, done) {
      total += chunk.length;
      done(total > MAX_EXPANDED_BYTES ? new UpdateError("The release archive expands beyond the size limit.") : null);
    },
  });

  try {
    await pipeline(createReadStream(archive), createGunzip(), counter);
  } catch (error) {
    throw error instanceof UpdateError ? error : new UpdateError("The release download is not a valid gzip archive.");
  }
}

async function runTar(state, args, action) {
  try {
    const output = await state.tar(args, { timeoutMs: TAR_TIMEOUT_MS, env: { ...state.environment, LC_ALL: "C" } });
    return String(output);
  } catch (error) {
    const detail = String(error?.stderr ?? "").trim().split("\n")[0] || errorText(error);
    throw new UpdateError(`tar could not ${action} the release archive: ${detail}`);
  }
}

function outputLines(text) {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/** The path components of a safe relative entry name, or an UpdateError. */
function entryParts(name) {
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  const unsafe = name.length > MAX_ENTRY_NAME
    || /[\u0000-\u001f\u007f\\]/.test(name)
    || name.startsWith("/")
    || parts.some((part) => part === "" || part === "." || part === "..");
  if (unsafe) {
    throw new UpdateError(`The release archive contains an unsafe entry name ${quoted(name)}.`);
  }

  return parts;
}

/**
 * Pair the plain listing (names) with the verbose listing (entry types) and return the single top-level directory.
 * Only regular files and directories are accepted: links, devices, FIFOs, and anything tar describes as a link fail.
 */
async function archiveTop(state, archive) {
  const names = outputLines(await runTar(state, ["-t", "-z", "-f", archive], "list"));
  const details = outputLines(await runTar(state, ["-t", "-v", "-z", "-f", archive], "list"));
  if (names.length === 0 || names.length > MAX_ENTRIES || names.length !== details.length) {
    throw new UpdateError("The release archive listing is empty, too large, or inconsistent.");
  }

  let top;
  for (const [index, name] of names.entries()) {
    const detail = details[index];
    const plain = (detail.startsWith("-") || detail.startsWith("d")) && detail.endsWith(` ${name}`);
    if (!plain || detail.includes(" -> ") || detail.includes(" link to ")) {
      throw new UpdateError(`The release archive entry ${quoted(name)} is not a plain file or directory.`);
    }

    const parts = entryParts(name);
    top ??= parts[0];
    if (parts[0] !== top || (parts.length === 1 && !detail.startsWith("d"))) {
      throw new UpdateError("The release archive must contain exactly one top-level directory.");
    }
  }

  return top;
}

/**
 * Walk the extracted tree without following links: make every directory owner-writable (so cleanup always succeeds)
 * and return the first entry that is not a plain, singly linked file or a directory.
 */
async function treeProblem(directory, root = directory) {
  let problem = null;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    const details = await lstat(target);
    if (details.isDirectory()) {
      problem = (await treeProblem(target, root)) ?? problem;
    } else if (!details.isFile() || details.nlink > 1) {
      problem ??= path.relative(root, target);
    }
  }
  return problem;
}

async function extractRelease(state, archive, destination) {
  const top = await archiveTop(state, archive);
  await mkdir(destination, { mode: 0o700 });
  try {
    await runTar(state, ["-x", "-z", "--no-same-owner", "--no-same-permissions", "-f", archive, "-C", destination], "extract");
  } catch (error) {
    await treeProblem(destination).catch(() => null);
    throw error;
  }

  const problem = await treeProblem(destination);
  if (problem) {
    throw new UpdateError(`The extracted release contains ${quoted(problem)}, which is not a plain file or directory.`);
  }

  const contents = await readdir(destination);
  if (contents.length !== 1 || contents[0] !== top) {
    throw new UpdateError("The release archive must contain exactly one top-level directory.");
  }

  return path.join(destination, top);
}

async function manifestVersion(file) {
  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    return typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function isPlainFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** The release must be exactly the announced version and ship the OpenCode bundle and its installer. */
async function verifyRelease(top, version) {
  for (const manifest of VERSIONED_MANIFESTS) {
    const found = await manifestVersion(path.join(top, ...manifest.split("/")));
    if (found !== version) {
      throw new UpdateError(`The release archive ${manifest} has version ${found ?? "(missing)"}, expected ${version}.`);
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!(await isPlainFile(path.join(top, ...file.split("/"))))) {
      throw new UpdateError(`The release archive has no ${file}; it cannot install the OpenCode plugin.`);
    }
  }
}

async function runInstaller(state, top, { scope, cwd }, version) {
  const args = [path.join(top, "useful-skills"), "install", "--host", "opencode", "--scope", scope];
  let output;
  try {
    output = await state.runner("node", args, { cwd, timeoutMs: INSTALL_TIMEOUT_MS, env: { ...state.environment, NO_COLOR: "1" } });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || "").trim() || errorText(error);
    throw new UpdateError(`The Useful Skills ${version} installer failed:\n${detail.slice(-2000)}`);
  }

  if (typeof output !== "string") {
    throw new UpdateError(`The Useful Skills ${version} installer did not report its result.`);
  }

  return output.trim();
}

/** Run `work` with a private temporary directory, removed afterwards, or synchronously if a signal ends this process first. */
async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-opencode-update-"));
  const removal = { recursive: true, force: true, maxRetries: 3 };
  const forget = onTermination(() => rmSync(directory, removal));
  try {
    return await work(directory);
  } finally {
    await rm(directory, removal);
    forget();
  }
}

/** Install the latest stable release over the installed runtime at `runtimeRoot`, in its recorded scope. */
export async function installOpenCodeUpdate(options = {}) {
  const state = updateOptions(options);
  const installed = trusted(() => runtimeInstall(state.runtimeRoot));
  if (!installed) {
    throw new UpdateError(NOT_INSTALLED);
  }

  const target = installTarget(installed, state.environment);
  const currentVersion = trusted(() => bundleVersion(state.runtimeRoot));
  const release = await stableRelease(state);
  if (!release || !isNewerVersion(release.version, currentVersion)) {
    return { updated: false, currentVersion, message: `Useful Skills ${currentVersion}: ${NO_NEWER_RELEASE}` };
  }

  const output = await withTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, "release.tar.gz");
    await saveDownload(await openDownload(state.fetcher, release.version), archive);
    await checkExpandedSize(archive);

    const top = await extractRelease(state, archive, path.join(directory, "release"));
    await verifyRelease(top, release.version);
    return runInstaller(state, top, target, release.version);
  });

  const after = trusted(() => runtimeInstall(state.runtimeRoot));
  if (after?.record.version !== release.version) {
    throw new UpdateError(`The Useful Skills ${release.version} installer finished, but the install record does not show the new version. Run ./useful-skills doctor --host opencode.`);
  }

  const lines = [output, `Updated Useful Skills for OpenCode from ${currentVersion} to ${release.version}. Restart OpenCode to load the update.`];
  return { updated: true, currentVersion: release.version, message: lines.filter(Boolean).join("\n") };
}
