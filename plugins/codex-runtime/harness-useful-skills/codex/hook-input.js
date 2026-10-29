import path from "node:path";

// Codex reports shell commands as `Bash` (including unified exec); the other names are tolerated aliases.
const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "exec_command", "local_shell", "container.exec"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ash", "ksh"]);
const MAX_ARGUMENTS = 64;

const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * One command string from a Codex shell tool input, or undefined. A string is used as is. An argument array such as
 * ["bash", "-lc", "rg foo"] yields its script; any other array is joined with every word single-quoted, so the safe
 * tokenizer reads it back as the same words. Nothing here executes or expands anything.
 */
export function codexCommand(toolInput) {
  const value = toolInput?.command ?? toolInput?.cmd;
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGUMENTS || !value.every((word) => typeof word === "string")) return undefined;

  if (SHELLS.has(path.posix.basename(value[0]))) {
    const flag = value.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (flag > 0) return typeof value[flag + 1] === "string" ? value[flag + 1] : undefined;
  }
  return value.map(quote).join(" ");
}

/** The Claude-shaped `{ session_id, cwd, tool_name: "Bash", tool_input }` that code-hint.js reads, from a Codex PreToolUse input. */
export function codexSearchInput(input) {
  if (input?.hook_event_name !== "PreToolUse" || !SHELL_TOOLS.has(input.tool_name)) return undefined;
  const command = codexCommand(input.tool_input);
  if (command === undefined) return undefined;
  return { session_id: input.session_id, cwd: input.cwd, tool_name: "Bash", tool_input: { command } };
}
