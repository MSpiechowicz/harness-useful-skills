import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPOSITORY = "MSpiechowicz/harness-useful-skills";
export const MARKETPLACE = "omp-useful-skills";
export const PLUGIN_ID = "oh-my-pi-useful-skills@omp-useful-skills";
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASE_BASE = `https://github.com/${REPOSITORY}/releases/tag/`;
export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LIST_TIMEOUT_MS = 8_000;
const MARKETPLACE_TIMEOUT_MS = 55_000;
const UPGRADE_TIMEOUT_MS = 75_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RELEASE_BYTES = 1024 * 1024;

export class UpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpdateError";
  }
}

/** Return a comparable stable semantic version, rejecting prereleases and ranges. */
export function versionTuple(value) {
  if (typeof value !== "string" || value.length > 80) {
    throw new UpdateError("Expected a stable MAJOR.MINOR.PATCH version.");
  }

  const match = STABLE_VERSION.exec(value);
  if (!match) {
    throw new UpdateError("Expected a stable MAJOR.MINOR.PATCH version.");
  }

  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every(Number.isSafeInteger)) {
    throw new UpdateError("Version components exceed the safe integer range.");
  }

  return parts;
}

/** True only when candidate is a newer stable semantic version than current. */
export function isNewerVersion(candidate, current) {
  const left = versionTuple(candidate);
  const right = versionTuple(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }

  return false;
}

async function packageVersion(root) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    versionTuple(packageJson.version);
    return packageJson.version;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateError(`Cannot read a valid useful-skills package version: ${detail}`);
  }
}

/** Read the latest published stable GitHub release without following redirects. */
export async function latestRelease(fetcher = fetch) {
  let response;
  try {
    response = await fetcher(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "omp-useful-skills-updater",
      },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateError(`Cannot retrieve the public GitHub release: ${detail}`);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new UpdateError(`GitHub release request failed (HTTP ${response.status}).`);
  }

  let body;
  try {
    body = await response.arrayBuffer();
  } catch {
    throw new UpdateError("GitHub returned unreadable release metadata.");
  }
  if (body.byteLength > MAX_RELEASE_BYTES) {
    throw new UpdateError("GitHub release response exceeded the size limit.");
  }

  let release;
  try {
    release = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new UpdateError("GitHub returned invalid release metadata.");
  }
  if (!release || typeof release !== "object") {
    throw new UpdateError("GitHub returned invalid release metadata.");
  }
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    throw new UpdateError("GitHub did not return a published stable release.");
  }
  if (!release.tag_name.startsWith("v")) {
    throw new UpdateError("GitHub did not return a published stable release.");
  }

  const version = release.tag_name.slice(1);
  versionTuple(version);
  return { version, tag: release.tag_name, url: RELEASE_BASE + release.tag_name };
}

async function execRunner(file, args, { cwd, timeoutMs }) {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_RELEASE_BYTES,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout);
}

function normalizedOptions(options = {}) {
  if (!options || typeof options !== "object") {
    throw new UpdateError("Update options must be an object.");
  }

  const profile = options.profile ?? process.env.OMP_PROFILE;
  if (profile !== undefined && (typeof profile !== "string" || profile.length === 0)) {
    throw new UpdateError("OMP profile must be a non-empty string.");
  }

  const root = path.resolve(options.root ?? PACKAGE_ROOT);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.runner !== undefined && typeof options.runner !== "function") {
    throw new UpdateError("Update runner must be a function.");
  }

  if (options.fetcher !== undefined && typeof options.fetcher !== "function") {
    throw new UpdateError("Update fetcher must be a function.");
  }

  return { root, cwd, profile, runner: options.runner ?? execRunner, fetcher: options.fetcher ?? fetch };
}

async function native(state, args, timeoutMs) {
  const command = [];
  if (state.profile) {
    command.push("--profile", state.profile);
  }

  command.push("plugin", ...args);
  try {
    const output = await state.runner("omp", command, { cwd: state.cwd, timeoutMs });
    if (typeof output !== "string") {
      throw new TypeError("runner did not return stdout");
    }

    return output;
  } catch {
    throw new UpdateError(`OMP plugin ${args[0] ?? "operation"} failed; inspect the native OMP command output and retry.`);
  }
}

function marketplaceEntries(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.marketplace)) {
    throw new UpdateError("OMP does not support `omp plugin list --json`; upgrade OMP before updating useful-skills.");
  }
  return data.marketplace;
}

async function installedPlugins(state) {
  let data;
  try {
    data = JSON.parse(await native(state, ["list", "--json"], LIST_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof UpdateError) {
      throw error;
    }

    throw new UpdateError("Cannot read native OMP marketplace installations.");
  }
  return marketplaceEntries(data);
}

/** Find the sole active marketplace installation which owns this running code. */
async function managedInstallation(state, expectedRoot) {
  const matches = [];
  for (const summary of await installedPlugins(state)) {
    if (!summary || typeof summary !== "object" || summary.id !== PLUGIN_ID) {
      continue;
    }

    if ((summary.scope !== "user" && summary.scope !== "project") || summary.shadowedBy) {
      continue;
    }

    if (!Array.isArray(summary.entries) || summary.entries.length !== 1) {
      continue;
    }

    const entry = summary.entries[0];
    if (!entry || typeof entry !== "object" || entry.enabled === false || entry.scope !== summary.scope) {
      continue;
    }

    if (typeof entry.installPath !== "string" || !path.isAbsolute(entry.installPath)) {
      continue;
    }

    const installPath = path.resolve(entry.installPath);
    const version = await packageVersion(installPath);
    if (entry.version !== version) {
      throw new UpdateError("OMP registry and installed useful-skills versions disagree; inspect `omp plugin list` before updating.");
    }

    matches.push({ scope: summary.scope, installPath, version });
  }

  if (matches.length > 1) {
    throw new UpdateError("useful-skills has multiple active marketplace installations; remove the ambiguity before updating.");
  }

  const installed = matches[0];
  return expectedRoot === undefined || installed?.installPath === path.resolve(expectedRoot) ? installed : undefined;
}

function reportFor(currentVersion, release, managed) {
  return {
    currentVersion,
    latestVersion: release?.version ?? null,
    updateAvailable: Boolean(release && managed && isNewerVersion(release.version, currentVersion)),
    managed,
    releaseUrl: release?.url ?? null,
  };
}

/** Check current installation ownership and public release metadata without installing code. */
export async function checkUpdate(options = {}) {
  const state = normalizedOptions(options);
  const currentVersion = await packageVersion(state.root);
  const installation = await managedInstallation(state, state.root);
  const release = await latestRelease(state.fetcher);
  const report = reportFor(currentVersion, release, Boolean(installation));
  if (!installation) {
    report.message = "This useful-skills installation is not an unambiguous active OMP marketplace installation. Source checkouts are never overwritten.";
  } else if (!release) {
    report.message = "No published stable GitHub release is available.";
  }

  return report;
}

/** Upgrade only the active, unambiguous native marketplace installation. */
export async function installUpdate(options = {}) {
  const state = normalizedOptions(options);
  const initial = await managedInstallation(state, state.root);
  if (!initial) {
    throw new UpdateError("This useful-skills installation is not an unambiguous active OMP marketplace installation. Source checkouts are never overwritten.");
  }

  const currentVersion = await packageVersion(state.root);
  const release = await latestRelease(state.fetcher);
  const report = reportFor(currentVersion, release, true);
  if (!release || !report.updateAvailable) {
    return { ...report, updated: false, message: "No newer stable release is available." };
  }

  await native(state, ["marketplace", "update", MARKETPLACE], MARKETPLACE_TIMEOUT_MS);
  const stillInitial = await managedInstallation(state, state.root);
  if (!stillInitial || stillInitial.scope !== initial.scope || stillInitial.installPath !== initial.installPath || stillInitial.version !== initial.version) {
    throw new UpdateError("The native installation changed during the update check; inspect it before retrying.");
  }

  await native(state, ["upgrade", PLUGIN_ID, "--scope", initial.scope], UPGRADE_TIMEOUT_MS);
  const installed = await managedInstallation(state, undefined);
  if (!installed || installed.scope !== initial.scope || !isNewerVersion(installed.version, currentVersion) || isNewerVersion(release.version, installed.version)) {
    throw new UpdateError("OMP did not install a newer stable useful-skills release; the marketplace may not have published it yet.");
  }

  return {
    ...report,
    currentVersion: installed.version,
    updated: true,
    updateAvailable: false,
    message: `Updated to ${installed.version} using OMP plugin upgrade. Restart OMP to load the updated extension.`,
  };
}

/** Contract used by the extension and launcher. */
export async function runUpdate(action, options = {}) {
  if (action === "check") {
    return checkUpdate(options);
  }
  if (action === "install") {
    return installUpdate(options);
  }

  throw new UpdateError("Update action must be check or install.");
}

/** Register this marketplace and install its plugin in the requested native scope. */
export async function installPlugin(options = {}) {
  const state = normalizedOptions(options);
  const scope = options.scope ?? "user";
  if (scope !== "user" && scope !== "project") {
    throw new UpdateError("Install scope must be user or project.");
  }
  await native(state, ["marketplace", "add", REPOSITORY], MARKETPLACE_TIMEOUT_MS);
  await native(state, ["install", PLUGIN_ID, "--scope", scope], UPGRADE_TIMEOUT_MS);
  return { scope, message: `Installed ${PLUGIN_ID} in ${scope} scope. Restart OMP to discover its skills.` };
}
