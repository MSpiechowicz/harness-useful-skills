/**
 * Host-neutral release lookup shared by the OMP updater (updater.js) and the OpenCode updater
 * (opencode/updater.js): the latest published stable GitHub release, stable version comparison, and the
 * optional GitHub token that lifts the anonymous rate limit.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPOSITORY = "MSpiechowicz/harness-useful-skills";
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASE_BASE = `https://github.com/${REPOSITORY}/releases/tag/`;

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const FETCH_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 5_000;
const MAX_RELEASE_BYTES = 1024 * 1024;
// GitHub tokens (ghp_, gho_, github_pat_, ...) are word characters; anything else never reaches a header.
const TOKEN_SHAPE = /^[A-Za-z0-9_]{1,255}$/;

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

/** A well-formed token, or null. */
export function usableToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return TOKEN_SHAPE.test(token) ? token : null;
}

async function ghAuthToken() {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: TOKEN_TIMEOUT_MS,
      maxBuffer: 4096,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    return String(stdout);
  } catch {
    return null;
  }
}

/**
 * The GitHub token used to lift the anonymous rate limit (60 requests an hour per IP):
 * GH_TOKEN, then GITHUB_TOKEN, then the GitHub CLI login. Null when none is available.
 */
export async function githubToken(env = process.env, cliToken = ghAuthToken) {
  return usableToken(env.GH_TOKEN) ?? usableToken(env.GITHUB_TOKEN) ?? usableToken(await cliToken());
}

function releaseRequest(fetcher, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "harness-useful-skills-updater",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // The token only ever goes to the fixed RELEASE_API origin: redirects are refused.
  return fetcher(RELEASE_API, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function rateLimitMessage(response, authenticated) {
  const limited = response.status === 429
    || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
  if (!limited) {
    return null;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  const at = Number.isFinite(reset) && reset > 0
    ? new Date(reset * 1000)
    : Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000) : null;
  const when = at ? ` Try again after ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : " Try again later.";
  const hint = authenticated ? "" : " Sign in with `gh auth login` or set GITHUB_TOKEN to raise the limit.";
  return `GitHub API rate limit reached.${when}${hint}`;
}

/**
 * Read the latest published stable GitHub release without following redirects. With a token the
 * request is authenticated; a rejected token (401) falls back to one anonymous request.
 */
export async function latestRelease(fetcher = fetch, token = null) {
  let response;
  let authenticated = Boolean(token);
  try {
    response = await releaseRequest(fetcher, token);
    if (response.status === 401 && authenticated) {
      authenticated = false;
      response = await releaseRequest(fetcher, null);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateError(`Cannot retrieve the public GitHub release: ${detail}`);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new UpdateError(rateLimitMessage(response, authenticated) ?? `GitHub release request failed (HTTP ${response.status}).`);
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
