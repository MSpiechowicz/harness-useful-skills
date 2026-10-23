/**
 * The Codex CLI as the installer uses it: every call runs `codex` from PATH with an explicit argv, a timeout,
 * captured output and CODEX_HOME pinned to the install target. JSON output is parsed defensively. No shell is used,
 * except cmd.exe for a Windows `codex.cmd` shim, and only for arguments cmd.exe cannot misread (see codexInvocation).
 * Installer-only; tests put a fake `codex` first on PATH.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { printableText } from "../opencode/paths.js";

const QUICK_MS = 60_000;
/** `marketplace add` and `plugin add` may clone a git repository. */
const CLONE_MS = 300_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const DETAIL_MAX = 600;
const TAG_CHECK_MS = 30_000;
/** Characters cmd.exe interprets even inside double quotes, or that end a quoted argument. */
const CMD_UNSAFE = /["%!^&|<>\r\n]/;

export const CODEX_MISSING = "The codex command was not found on PATH. Install the Codex CLI, then run `./useful-skills install --host codex` again.";

/** Thrown when `codex` cannot be started because it is not on PATH. */
export class CodexMissingError extends Error {
  constructor() {
    super(CODEX_MISSING);
  }
}

const shown = (args) => `\`codex ${args.join(" ")}\``;

/** The useful part of Codex's error output: everything but its PATH-alias warnings, shortened. */
function detail({ stderr, stdout }) {
  const lines = `${stderr}\n${stdout}`.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("WARNING:"));
  const text = lines.join(" ");
  return printableText(text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}...` : text);
}

/** Parse a JSON object from stdout, tolerating text around it; throws a message naming the command. */
function parseJson(stdout, args) {
  const text = stdout.trim();
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`${shown(args)} did not print the expected JSON.`);
}

/** An environment value by case-insensitive name, as Windows looks variables up. */
function envValue(environment, name) {
  const key = Object.keys(environment).find((each) => each.toUpperCase() === name);
  return key === undefined ? undefined : environment[key];
}

const isFile = (file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true;
const isDirectory = (directory) => typeof directory === "string" && statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * A working directory for child processes that is not wherever the installer was started (a project could plant files
 * there): `preferred` (the Codex home) when it exists, else the user's home, else the temp directory.
 */
export function neutralCwd(preferred) {
  return [preferred, os.homedir(), os.tmpdir()].find(isDirectory) ?? path.parse(process.cwd()).root;
}

/**
 * Where `codex` is on Windows, among the extensions PATHEXT lists: codex.exe anywhere on PATH (it runs without a shell),
 * else the first codex.cmd or codex.bat shim in PATH order. Returns `{file, shim}` or null.
 */
export function findWindowsCodex(environment, exists = isFile) {
  const allowed = (envValue(environment, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";");
  // Relative entries would resolve against the working directory, so they are skipped.
  const directories = (envValue(environment, "PATH") ?? "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter((entry) => entry && path.win32.isAbsolute(entry));
  const passes = [[".exe"], [".cmd", ".bat"]].map((group) => group.filter((extension) => allowed.includes(extension)));

  for (const extensions of passes) {
    for (const directory of directories) {
      for (const extension of extensions) {
        const file = path.win32.join(directory, `codex${extension}`);
        if (exists(file)) return { file, shim: extension !== ".exe" };
      }
    }
  }

  return null;
}

/** One cmd.exe argument: double-quoted, with trailing backslashes doubled so they do not escape the closing quote. */
const cmdQuote = (argument) => `"${argument.replace(/(\\+)$/, "$1$1")}"`;

/**
 * The absolute path of cmd.exe: an absolute COMSPEC, else `<SystemRoot>\System32\cmd.exe`. A bare `cmd.exe` is never
 * used, because Windows would search the working directory first. Throws when neither variable is absolute.
 */
export function windowsShell(environment) {
  const comspec = envValue(environment, "COMSPEC");
  if (comspec && path.win32.isAbsolute(comspec)) return comspec;

  const systemRoot = envValue(environment, "SYSTEMROOT");
  if (systemRoot && path.win32.isAbsolute(systemRoot)) return path.win32.join(systemRoot, "System32", "cmd.exe");
  throw new Error("Codex is installed as a codex.cmd shim, which has to run through cmd.exe, but neither COMSPEC nor SystemRoot is an absolute path, so cmd.exe cannot be located safely. Set COMSPEC to the full path of cmd.exe, or install the codex.exe build of the Codex CLI.");
}

/**
 * How to start `codex args...`: `{command, args, verbatim}` for spawnSync. POSIX and codex.exe run directly. A Windows
 * `.cmd`/`.bat` shim must run through `cmd.exe /d /s /c`; that is refused when any argument holds a character cmd.exe
 * would interpret, rather than escaped heuristically. Throws CodexMissingError when Windows has no codex on PATH.
 */
export function codexInvocation(args, { platform = process.platform, environment = process.env, exists = isFile } = {}) {
  if (platform !== "win32") return { command: "codex", args, verbatim: false };

  const found = findWindowsCodex(environment, exists);
  if (!found) throw new CodexMissingError();
  if (!found.shim) return { command: found.file, args, verbatim: false };

  const unsafe = [found.file, ...args].find((argument) => CMD_UNSAFE.test(argument));
  if (unsafe !== undefined) {
    throw new Error(`Codex is installed as ${found.file}, which has to run through cmd.exe, and the argument ${JSON.stringify(unsafe)} contains a character cmd.exe would interpret (" % ! ^ & | < > or a line break). Use paths without these characters, or install the codex.exe build of the Codex CLI.`);
  }

  return { command: windowsShell(environment), args: ["/d", "/s", "/c", `"${[found.file, ...args].map(cmdQuote).join(" ")}"`], verbatim: true };
}

/**
 * Whether tag `ref` exists in the GitHub repository `owner/repo`, by `git ls-remote` (no shell, prompts off, timeout).
 * Resolves to `{state: "present" | "absent"}`, or `{state: "unknown", reason}` when git is missing, offline or fails.
 */
export function releaseTagState({ environment = process.env, repository, ref }) {
  const tag = `refs/tags/${ref}`;
  const result = spawnSync("git", ["ls-remote", "--tags", `https://github.com/${repository}`, tag], {
    cwd: neutralCwd(),
    env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: TAG_CHECK_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.error?.code === "ENOENT") return { state: "unknown", reason: "git is not on PATH" };
  if (result.error) return { state: "unknown", reason: result.error.code === "ETIMEDOUT" ? `git timed out after ${TAG_CHECK_MS / 1000}s` : printableText(result.error.message) };
  if (result.status !== 0) return { state: "unknown", reason: `git ls-remote failed: ${detail({ stderr: result.stderr ?? "", stdout: "" }) || `exit ${result.status}`}` };

  const listed = (result.stdout ?? "").split("\n").some((line) => line.split("\t")[1]?.trim() === tag);
  return { state: listed ? "present" : "absent" };
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOr = (value, fallback = undefined) => (typeof value === "string" ? value : fallback);

/**
 * A client for one Codex home. Methods throw an Error naming the failed command, or CodexMissingError.
 * `environment` is passed to `codex` (PATH included) with CODEX_HOME set to `codexHome` when given.
 */
export function codexClient({ environment = process.env, codexHome } = {}) {
  const env = codexHome ? { ...environment, CODEX_HOME: codexHome } : { ...environment };

  function run(args, timeout = QUICK_MS) {
    const invocation = codexInvocation(args, { environment: env });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: neutralCwd(codexHome),
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
    });
    if (result.error?.code === "ENOENT") throw new CodexMissingError();
    if (result.error) {
      const reason = result.error.code === "ETIMEDOUT" ? `timed out after ${timeout / 1000}s` : result.error.message;
      throw new Error(`${shown(args)} could not run (${printableText(reason)}).`);
    }

    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function check(args, timeout) {
    const result = run(args, timeout);
    if (result.status !== 0) throw new Error(`${shown(args)} failed (exit ${result.status ?? "signal"}): ${detail(result) || "no output"}`);
    return result;
  }

  return {
    /** The first line `codex --version` prints, such as `codex-cli 0.154.0`. */
    version() {
      return printableText(check(["--version"]).stdout.trim().split("\n")[0] ?? "");
    },

    /** Configured marketplaces as `{name, sourceType, source}`; built-in ones may have no source. */
    listMarketplaces() {
      const args = ["plugin", "marketplace", "list", "--json"];
      const list = parseJson(check(args).stdout, args).marketplaces;
      if (!Array.isArray(list)) throw new Error(`${shown(args)} did not list marketplaces.`);
      return list.filter((item) => isObject(item) && typeof item.name === "string").map((item) => ({
        name: item.name,
        sourceType: stringOr(item.marketplaceSource?.sourceType),
        source: stringOr(item.marketplaceSource?.source),
      }));
    },

    addMarketplace(source, ref) {
      check(["plugin", "marketplace", "add", source, ...(ref ? ["--ref", ref] : [])], CLONE_MS);
    },

    /** Remove a marketplace; resolves to false when Codex says it is not configured. */
    removeMarketplace(name) {
      const args = ["plugin", "marketplace", "remove", name];
      const result = run(args);
      if (result.status === 0) return true;
      if (/not configured or installed/.test(result.stderr)) return false;
      throw new Error(`${shown(args)} failed (exit ${result.status ?? "signal"}): ${detail(result) || "no output"}`);
    },

    /** Install a plugin; resolves to `{pluginId, version}` as far as Codex reported them. */
    addPlugin(pluginId) {
      const args = ["plugin", "add", pluginId, "--json"];
      const report = parseJson(check(args, CLONE_MS).stdout, args);
      return { pluginId: stringOr(report.pluginId, pluginId), version: stringOr(report.version) };
    },

    /** Installed plugins as `{pluginId, version, installed, enabled}`. */
    listPlugins() {
      const args = ["plugin", "list", "--json"];
      const list = parseJson(check(args).stdout, args).installed;
      if (!Array.isArray(list)) throw new Error(`${shown(args)} did not list installed plugins.`);
      return list.filter((item) => isObject(item) && typeof item.pluginId === "string").map((item) => ({
        pluginId: item.pluginId,
        version: stringOr(item.version),
        installed: item.installed !== false,
        enabled: item.enabled === true,
      }));
    },

    removePlugin(pluginId) {
      check(["plugin", "remove", pluginId]);
    },

    /** A stdio MCP server as `{name, command, args, env, enabled}`, `{name, transport}` for another transport, or null when absent. */
    getMcp(name) {
      const args = ["mcp", "get", name, "--json"];
      const result = run(args);
      if (result.status !== 0 && /No MCP server named/.test(result.stderr)) return null;
      if (result.status !== 0) throw new Error(`${shown(args)} failed (exit ${result.status ?? "signal"}): ${detail(result) || "no output"}`);

      const server = parseJson(result.stdout, args);
      const transport = isObject(server.transport) ? server.transport : {};
      if (transport.type !== "stdio") return { name, transport: stringOr(transport.type, "unknown") };
      return {
        name,
        command: stringOr(transport.command, ""),
        args: Array.isArray(transport.args) ? transport.args.map(String) : [],
        env: isObject(transport.env) ? Object.fromEntries(Object.entries(transport.env).map(([key, value]) => [key, String(value)])) : {},
        enabled: server.enabled !== false,
      };
    },

    /** Register a stdio server; Codex replaces a server of the same name. */
    addMcp({ name, command, args, env }) {
      const pairs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      check(["mcp", "add", name, ...pairs, "--", command, ...args]);
    },

    removeMcp(name) {
      check(["mcp", "remove", name]);
    },
  };
}

/** Whether a live MCP server (from getMcp) has the command, arguments and environment of `entry`. */
export function sameMcp(live, entry) {
  if (!live || !entry || live.command !== entry.command) return false;
  if (JSON.stringify(live.args) !== JSON.stringify(entry.args)) return false;
  const sorted = (env) => JSON.stringify(Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return sorted(live.env) === sorted(entry.env);
}

const GITHUB = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** A comparable form of a marketplace source: a real path for a local one, `github:owner/repo` for GitHub. */
function sourceKey(source) {
  if (path.isAbsolute(source)) {
    try {
      return realpathSync(source);
    } catch {
      return path.resolve(source);
    }
  }

  const github = GITHUB.exec(source);
  return github ? `github:${github[1]}/${github[2]}`.toLowerCase() : source;
}

/** Whether two marketplace sources (as given to `marketplace add` or as listed) name the same repository or directory. */
export function sameSource(a, b) {
  return typeof a === "string" && typeof b === "string" && sourceKey(a) === sourceKey(b);
}

/**
 * The `ref` Codex stored for marketplace `name` in `<codexHome>/config.toml` (the list output omits it), or null.
 * Read-only and deliberately narrow: a plain `[marketplaces.<name>]` table with a quoted `ref = "..."`.
 */
export function marketplaceRef(codexHome, name) {
  let text;
  try {
    text = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return null;
  }

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[\\s*marketplaces\\s*\\.\\s*(?:"${escaped}"|${escaped})\\s*\\]\\s*(?:#.*)?$`);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;

  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*ref\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) return match[1] ?? match[2];
  }

  return null;
}
