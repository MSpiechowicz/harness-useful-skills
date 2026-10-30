import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { tokenize } from "../code-hint.js";
import { resolveHarnessMemory } from "../doctor-setup.js";
import { within } from "./hook-input.js";

const CODE_TOOL_PREFIX = "xd://mcp__harness_memory_code_";
const MINTED_TOOL_PREFIX = "mcp__harness_memory_code_";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".py", ".svelte", ".vue", ".astro"]);
const SOURCE_FOLDERS = new Set(["src", "lib", "app", "apps", "crates", "packages", "source", "components", "ui", "server", "client", "pkg", "cmd", "internal"]);
const READS_BEFORE_NUDGE = 3;
const REPO_TIMEOUT_MS = 1000;
const MAX_SESSIONS = 40;

export const NUDGE_INDEXED =
  "This repository is in the code index. `code_map` shows its key files and signatures in one call, `code_symbol` where a name is defined and who uses it, `code_path` how one part reaches another. Use them before reading more files.";
export const NUDGE_NONE =
  "This repository is not in the code index yet. The first `code_map` call builds it and then shows its key files and signatures in one call, `code_symbol` shows where a name is defined and who uses it, `code_path` how one part reaches another. Use them before reading more files.";

/** Whether a tool event is a call of a harness-memory code tool: a `read` or `write` of an `xd://` path, or the minted MCP tool name. */
export function isCodeToolUse(event) {
  const where = event?.input?.path;
  return (typeof event?.toolName === "string" && event.toolName.startsWith(MINTED_TOOL_PREFIX)) || (event?.toolName === "read" || event?.toolName === "write") && typeof where === "string" && where.startsWith(CODE_TOOL_PREFIX);
}

// A glob names folders by any part of it, a plain argument by its last part, and a file (one with an extension) is no folder.
function isSourceFolder(word) {
  const parts = word.split(/[\\/]/).filter(Boolean);
  if (/[*?[]/.test(word)) return parts.some(part => SOURCE_FOLDERS.has(part));
  const last = parts.at(-1);
  return last !== undefined && path.extname(last) === "" && SOURCE_FOLDERS.has(last);
}

/** Whether a Bash command line starts a directory exploration in the project. Parses only, never executes. */
export function isExploration(command, cwd) {
  for (const { words, unsafe } of tokenize(command)) {
    if (unsafe) continue;
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
    const tool = words[index] && path.posix.basename(words[index]);
    const args = words.slice(index + 1);
    let places = args.filter(arg => !arg.startsWith("-"));
    if (tool === "find") {
      const expression = args.findIndex(arg => /^[-!(]/.test(arg));
      places = args.slice(0, expression < 0 ? args.length : expression);
    }
    if (places.some(place => !within(cwd, place))) continue;
    const recursive = args.some(arg => arg === "--recursive" || /^-[A-Za-z]*R/.test(arg));
    const onSource = places.some(isSourceFolder);
    if (tool === "find" || tool === "tree" || ((tool === "ls" || tool === "wc") && onSource) || (tool === "ls" && recursive)) return true;
  }
  return false;
}

/** Whether a read tool event reads a source file of the project. `xd://` and other URLs do not count. */
export function isSourceRead(event, cwd) {
  const where = event?.input?.path;
  if (event?.toolName !== "read" || typeof where !== "string" || /^[a-z][a-z0-9+.-]*:\/\//i.test(where)) return false;
  const file = where.replace(/:\d[\w,.+-]*$/, "");
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) && within(cwd, file);
}

/**
 * The exploration nudge of OMP sessions. In memory per session id: the nudge comes once, and only while the session
 * has made no code tool call.
 */
export function createNudgeTracker() {
  const sessions = new Map();
  const sessionOf = id => {
    if (typeof id !== "string" || !id) return undefined;
    if (!sessions.has(id)) {
      sessions.set(id, { codeUsed: false, nudged: false, reads: 0 });
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    return sessions.get(id);
  };
  return {
    /** Record a code tool call of the session. */
    noteToolUse(event, sessionId) {
      if (isCodeToolUse(event)) {
        const session = sessionOf(sessionId);
        if (session) session.codeUsed = true;
      }
    },
    /** Give the claim back when no nudge could be sent, so that a later trigger can try again. */
    release(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.nudged = false;
    },
    /** Whether this finished tool call is the one that should carry the nudge. Holds the session's claim when it is. */
    claim(event, sessionId, cwd) {
      const session = typeof cwd === "string" && !event?.isError ? sessionOf(sessionId) : undefined;
      if (!session || session.codeUsed || session.nudged) return false;
      let exploring = false;
      if (event.toolName === "bash") {
        exploring = event.input?.async !== true && typeof event.input?.command === "string"
          && (typeof event.input.cwd !== "string" || within(cwd, event.input.cwd)) && isExploration(event.input.command, cwd);
      } else if (isSourceRead(event, cwd)) {
        session.reads += 1;
        exploring = session.reads >= READS_BEFORE_NUDGE;
      }
      if (exploring) session.nudged = true;
      return exploring;
    },
  };
}

/** The nudge text for the project, or undefined. Asks the read-only `code repo` command and is silent on any error. */
export function repoNudge(project, { env = process.env, services = {} } = {}) {
  return new Promise(resolve => {
    try {
      const binary = (services.resolve ?? resolveHarnessMemory)({ cwd: project, env });
      if (!binary) return resolve(undefined);
      (services.execFile ?? execFile)(
        binary,
        ["code", "repo", "--project", project, "--json"],
        { cwd: os.tmpdir(), timeout: REPO_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(undefined);
          try {
            const state = JSON.parse(String(stdout)).state;
            resolve(state === "indexed" ? NUDGE_INDEXED : state === "none" ? NUDGE_NONE : undefined);
          } catch {
            resolve(undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}
