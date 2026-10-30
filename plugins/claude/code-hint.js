import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveHarnessMemory } from "./doctor-setup.js";

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:::|\.)?[\w$]*$/;
const MIN_TERM = 3;
const MAX_TERM = 80;
const HINT_TIMEOUT_MS = 1000;
const MAX_HINT_CHARS = 600;
const MAX_NAMES_PER_SEARCH = 3;
const MAX_HINTS_PER_SESSION = 5;
const MAX_LOOKUPS_PER_SESSION = 20;
const MAX_SEEN_TERMS = 40;
const MAX_SESSIONS = 40;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 64 * 1024;
const STATE_FILE = "code-hint-state.json";

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
// Short option letters and long options that consume the next argument, per tool. Unknown long options take none.
const SHORT_VALUE = { grep: "ABCmfdD", egrep: "ABCmfdD", fgrep: "ABCmfdD", rg: "ABCmgtTfjMErd", ag: "ABCGmgsdp", ack: "ABCmgd" };
const LONG_VALUE = new Set([
  "include", "exclude", "exclude-dir", "include-dir", "max-count", "file", "after-context", "before-context", "context",
  "glob", "type", "type-not", "iglob", "max-depth", "max-filesize", "threads", "replace", "ignore", "path-to-ignore",
  "color", "colour", "directories", "devices", "binary-files", "label", "type-add", "pre", "encoding", "sort", "sortr",
]);

/** The index of the last character of a redirection that starts at `at`: its operator, `&` and the plain or quoted target. */
function skipRedirect(text, at) {
  let i = at;
  while (text[i + 1] === ">" || text[i + 1] === "<" || text[i + 1] === "&" || text[i + 1] === "|") i += 1;
  if (text[i + 1] === "(") return i;
  let j = i + 1;
  while (text[j] === " " || text[j] === "\t") j += 1;
  const quote = text[j];
  if (quote === "'" || quote === '"') {
    const end = text.indexOf(quote, j + 1);
    return end < 0 ? i : end;
  }
  while (j < text.length && !" \t|;&\n\r<>()`$".includes(text[j])) j += 1;
  return j - 1 > i ? j - 1 : i;
}

/**
 * Split a shell command line into segments of words without executing or expanding anything. A segment containing a
 * command substitution, backtick or unquoted variable is marked unsafe and is never searched for a term.
 */
export function tokenize(command) {
  const segments = [];
  let words = [];
  let word = "";
  let started = false;
  let unsafe = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || unsafe) segments.push({ words, unsafe });
    words = [];
    unsafe = false;
  };
  const text = String(command ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return [];
      word += text.slice(i + 1, end);
      started = true;
      i = end;
    } else if (ch === '"') {
      started = true;
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === "\\" && j + 1 < text.length) {
          // in double quotes a backslash only escapes $, a backtick, a double quote, a backslash and a newline
          if ("$`\"\\\n".includes(text[j + 1])) {
            j += 1;
          }
          word += text[j];
        } else {
          if (text[j] === "`" || text[j] === "$") unsafe = true;
          word += text[j];
        }
      }
      if (j >= text.length) return [];
      i = j;
    } else if (ch === "\\") {
      if (i + 1 < text.length) {
        i += 1;
        word += text[i];
        started = true;
      }
    } else if (ch === "`" || ch === "$" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "<" || ch === ">") {
      // Substitutions, groups and redirections: the word cannot be trusted as a literal.
      if (ch === ">" || ch === "<") {
        unsafe = unsafe || text[i + 1] === "(";
        // a file descriptor number before the operator is part of the redirection
        if (started && /^\d+$/.test(word)) started = false;
        i = skipRedirect(text, i);
        endWord();
      } else {
        unsafe = true;
        word += ch;
        started = true;
      }
    } else if (ch === "&" && text[i + 1] === ">") {
      i = skipRedirect(text, i + 1);
      endWord();
    } else if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") {
      endSegment();
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else {
      word += ch;
      started = true;
    }
  }
  endSegment();
  return segments;
}

/**
 * The pattern a grep-like invocation searches for, or undefined. With -f/--file the patterns come from a file, so the
 * first positional argument is a path and no term is extracted.
 */
function patternOf(tool, args) {
  const shortValue = SHORT_VALUE[tool] ?? "";
  let term;
  let found = false;
  let fromFile = false;
  const take = value => {
    if (!found) {
      found = true;
      term = value;
    }
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      take(args[i + 1]);
      break;
    }
    if (arg.startsWith("--")) {
      const [name, ...rest] = arg.slice(2).split("=");
      if (name === "file") fromFile = true;
      if (name === "regexp") {
        take(rest.length ? rest.join("=") : args[i + 1]);
        if (rest.length === 0) i += 1;
      } else if (rest.length === 0 && LONG_VALUE.has(name)) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k += 1) {
        if (arg[k] === "e") {
          take(k + 1 < arg.length ? arg.slice(k + 1) : args[i + 1]);
          if (k + 1 === arg.length) i += 1;
          break;
        }
        if (shortValue.includes(arg[k])) {
          if (arg[k] === "f") fromFile = true;
          if (k + 1 === arg.length) i += 1;
          break;
        }
      }
      continue;
    }
    take(arg);
  }
  return fromFile ? undefined : term;
}

/** The search term of a Bash command that runs grep, rg, ag, ack or git grep, or undefined. */
export function bashSearchTerm(command) {
  for (const { words, unsafe } of tokenize(command)) {
    if (unsafe) continue;
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
    let tool = words[index] && path.posix.basename(words[index]);
    let args = words.slice(index + 1);
    if (tool === "git") {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) k += args[k] === "-C" || args[k] === "-c" ? 2 : 1;
      if (args[k] !== "grep") continue;
      tool = "grep";
      args = args.slice(k + 1);
    } else if (!SEARCH_COMMANDS.has(tool)) {
      continue;
    }
    const term = patternOf(tool, args);
    if (term !== undefined) return term;
  }
  return undefined;
}

/** The identifier-like search term of a Grep or Bash tool call, else undefined. */
export function searchTerm(input) {
  const name = input?.tool_name;
  const toolInput = input?.tool_input;
  let term;
  if (name === "Grep") term = toolInput?.pattern;
  else if (name === "Bash") term = bashSearchTerm(toolInput?.command);
  if (typeof term !== "string") return undefined;
  return term.length >= MIN_TERM && term.length <= MAX_TERM && IDENTIFIER.test(term) ? term : undefined;
}

/**
 * The identifier alternatives of a Grep or Bash search in order, for patterns such as `a|b|c`, `a\|b`, `(a|b)` or
 * `\b(a|b)\b`. Alternatives that are not identifiers are skipped. A plain identifier pattern yields itself.
 */
export function searchTerms(input) {
  const name = input?.tool_name;
  const toolInput = input?.tool_input;
  let pattern;
  if (name === "Grep") pattern = toolInput?.pattern;
  else if (name === "Bash") pattern = bashSearchTerm(toolInput?.command);
  if (typeof pattern !== "string" || pattern.length > MAX_TERM * 8) return [];
  const names = pattern
    .replace(/\\[b<>]/g, "")
    .replace(/\\?[()]/g, "")
    .replace(/[\^$]/g, "")
    .split(/\\?\|/)
    .filter(term => term.length >= MIN_TERM && term.length <= MAX_TERM && IDENTIFIER.test(term));
  return [...new Set(names)];
}

function sessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
}

function readState(file) {
  try {
    const raw = readFileSync(file);
    if (raw.length > MAX_STATE_BYTES) return {};
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(dir, file, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function pruned(state, now) {
  const entries = Object.entries(state)
    .filter(([, value]) => value && typeof value === "object" && Number.isFinite(value.t) && now - value.t < SESSION_TTL_MS)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, MAX_SESSIONS);
  return Object.fromEntries(entries);
}

function askHint(binary, project, term, execute) {
  return new Promise(resolve => {
    try {
      execute(
        binary,
        ["code", "hint", "--project", project, "--query", term, "--json"],
        { cwd: os.tmpdir(), timeout: HINT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          try {
            const hint = JSON.parse(String(stdout)).hint;
            const clean = typeof hint === "string" ? hint.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_HINT_CHARS) : "";
            resolve(clean || null);
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The one-line code-tool hint for a Grep or Bash search tool call, or undefined. Never throws: any failure is silence.
 * `enabled` is false when the code-graph stage is off; `dataDir` is the private plugin data directory holding the
 * per-session dedupe state; `services` replaces the process runner and the clock in tests.
 */
export async function codeHint(input, { enabled = true, dataDir, env = process.env, services = {} } = {}) {
  try {
    if (!enabled || typeof dataDir !== "string" || !path.isAbsolute(dataDir)) return undefined;
    const sessionId = input?.session_id;
    const project = input?.cwd;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return undefined;
    if (typeof project !== "string" || !path.isAbsolute(project)) return undefined;
    const terms = searchTerms(input);
    if (!terms.length) return undefined;

    const now = (services.now ?? Date.now)();
    const file = path.join(dataDir, STATE_FILE);
    const key = sessionKey(sessionId);
    const state = pruned(readState(file), now);
    const session = state[key] ?? { t: now, hints: 0, lookups: 0, seen: [] };
    let lookups = Number.isFinite(session.lookups) ? session.lookups : session.seen.length;
    const candidates = terms.filter(term => !session.seen.includes(term)).slice(0, MAX_NAMES_PER_SEARCH);
    if (session.hints >= MAX_HINTS_PER_SESSION || lookups >= MAX_LOOKUPS_PER_SESSION || !candidates.length) return undefined;

    const binary = (services.resolve ?? resolveHarnessMemory)({ cwd: project, env });
    if (!binary) return undefined;
    let hint = null;
    for (const term of candidates) {
      if (lookups >= MAX_LOOKUPS_PER_SESSION) break;
      hint = await askHint(binary, project, term, services.execFile ?? execFile);
      lookups += 1;
      session.seen = [...session.seen, term].slice(-MAX_SEEN_TERMS);
      if (hint) {
        session.hints += 1;
        break;
      }
    }

    session.t = now;
    session.lookups = lookups;
    state[key] = session;
    writeState(dataDir, file, pruned(state, now));
    return hint ?? undefined;
  } catch {
    return undefined;
  }
}
