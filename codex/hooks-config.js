/**
 * Registration of the Codex PreToolUse hook in `$CODEX_HOME/hooks.json`, the user-level hooks file Codex reads next to
 * config.toml (which the installer never edits). Only our own handler is ever added or removed: it is recognised by its
 * exact command, every other key and handler is kept. A file whose text is not what JSON.stringify would write is saved
 * once as `hooks.json.useful-skills.bak` before it is rewritten. Installer-only.
 */
import { copyFileSync, readFileSync, rmSync } from "node:fs";

import { writeAtomic } from "../model-roles.js";
import { lstatOrNull, writeTargetProblem } from "../opencode/paths.js";
import { RUNTIME_DIR, atHome } from "./paths.js";

export const HOOKS_REL = "hooks.json";
export const HOOK_SCRIPT_REL = `${RUNTIME_DIR}/codex/hooks.js`;
export const HOOK_EVENT = "PreToolUse";
const BACKUP = "hooks.json.useful-skills.bak";
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_SECONDS = 5;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The command Codex runs for `codexHome`, or `{ reason }` when the path cannot be quoted safely for a shell. */
export function hookCommand(codexHome) {
  const script = atHome(codexHome, HOOK_SCRIPT_REL);
  const unsafe = process.platform === "win32" ? /["$`%!^&|<>]/ : /["$`\\!]/;
  if (unsafe.test(script)) return { reason: `${script} contains characters that cannot be quoted safely in a hook command` };
  return { command: `node "${script}"` };
}

const ownHandler = (command) => (handler) => isRecord(handler) && handler.command === command;

function readFile(codexHome) {
  const file = atHome(codexHome, HOOKS_REL);
  const blocked = writeTargetProblem(codexHome, HOOKS_REL);
  if (blocked) throw new Error(blocked);
  const stat = lstatOrNull(file);
  if (!stat) return { file, text: undefined, data: {} };
  if (stat.size > MAX_BYTES) throw new Error(`${file} is too large`);

  const text = readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isRecord(data)) throw new Error(`${file} must hold a JSON object`);
  if (data.hooks !== undefined && !isRecord(data.hooks)) throw new Error(`${file}: "hooks" must be an object`);
  if (data.hooks?.[HOOK_EVENT] !== undefined && !Array.isArray(data.hooks[HOOK_EVENT])) throw new Error(`${file}: "hooks.${HOOK_EVENT}" must be a list`);
  return { file, text, data };
}

/** The groups of `data` that hold our handler, as `{ group, count }`. */
function ownGroups(data, command) {
  return (data.hooks?.[HOOK_EVENT] ?? [])
    .filter((group) => isRecord(group) && Array.isArray(group.hooks))
    .map((group) => ({ group, count: group.hooks.filter(ownHandler(command)).length }))
    .filter(({ count }) => count > 0);
}

/** Remove our handlers, and only the containers that this leaves empty. Returns whether anything was removed. */
function strip(data, command) {
  const groups = data.hooks?.[HOOK_EVENT];
  if (!Array.isArray(groups)) return false;

  let removed = false;
  const kept = groups.filter((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks) || !group.hooks.some(ownHandler(command))) return true;
    group.hooks = group.hooks.filter((handler) => !ownHandler(command)(handler));
    removed = true;
    return group.hooks.length > 0;
  });
  if (!removed) return false;

  if (kept.length > 0) {
    data.hooks[HOOK_EVENT] = kept;
  } else {
    delete data.hooks[HOOK_EVENT];
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
  }
  return true;
}

function render(data, original) {
  const indent = original?.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? "  ";
  const eol = original === undefined || original.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(data, null, indent)}${eol}`;
}

function save({ file, text }, data, codexHome) {
  if (text === undefined) {
    writeAtomic(file, render(data, undefined));
    return;
  }

  const mode = lstatOrNull(file).mode & 0o777;
  if (text !== render(JSON.parse(text), text)) {
    const backup = atHome(codexHome, BACKUP);
    if (!lstatOrNull(backup)) copyFileSync(file, backup);
  }
  writeAtomic(file, render(data, text), mode);
}

/** Whether our handler is registered: `{ state: "registered" | "missing" }`, or `{ state: "unreadable", reason }`. */
export function hookState(codexHome) {
  const built = hookCommand(codexHome);
  if (built.reason) return { state: "unreadable", reason: built.reason };
  try {
    const { data } = readFile(codexHome);
    return { state: ownGroups(data, built.command).length > 0 ? "registered" : "missing" };
  } catch (error) {
    return { state: "unreadable", reason: error.message };
  }
}

/** Register the hook exactly once. Returns `{ changed, file }`; throws, with nothing written, when the file or path cannot be used. */
export function registerHook(codexHome) {
  const built = hookCommand(codexHome);
  if (built.reason) throw new Error(built.reason);

  const current = readFile(codexHome);
  const { data } = current;
  const groups = ownGroups(data, built.command);
  if (groups.length === 1 && groups[0].count === 1) return { changed: false, file: current.file };

  strip(data, built.command);
  data.hooks ??= {};
  data.hooks[HOOK_EVENT] ??= [];
  data.hooks[HOOK_EVENT].push({ matcher: "^Bash$", hooks: [{ type: "command", command: built.command, timeout: TIMEOUT_SECONDS }] });
  save(current, data, codexHome);
  return { changed: true, file: current.file };
}

/** Remove our hook and nothing else. Returns `{ changed, file }`; the file is deleted when nothing else is left in it. */
export function unregisterHook(codexHome) {
  const built = hookCommand(codexHome);
  if (built.reason) throw new Error(built.reason);

  const current = readFile(codexHome);
  if (!strip(current.data, built.command)) return { changed: false, file: current.file };

  if (Object.keys(current.data).length === 0) rmSync(current.file);
  else save(current, current.data, codexHome);
  return { changed: true, file: current.file };
}
