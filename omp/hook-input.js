import path from "node:path";

// OMP names its tools in lowercase: `grep` takes `pattern`, `bash` takes `command`.
const TOOL_NAMES = { grep: "Grep", bash: "Bash" };

/** Whether `where`, relative to `cwd` or absolute, is `cwd` or inside it. */
export function within(cwd, where) {
  const relative = path.relative(cwd, path.resolve(cwd, where));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The Claude-shaped `{ session_id, cwd, tool_name, tool_input }` that code-hint.js reads, from an OMP tool event, or
 * undefined for any other tool. Nothing here executes anything.
 */
export function ompSearchInput(event, ctx) {
  const toolName = TOOL_NAMES[event?.toolName];
  if (!toolName) return undefined;
  const key = toolName === "Grep" ? "pattern" : "command";
  const value = event.input?.[key];
  if (typeof value !== "string") return undefined;
  // the hint names the project of the session: a search of another folder, or a command left running in the
  // background (its result is only that it started), gets none
  const cwd = ctx?.cwd;
  const elsewhere = toolName === "Grep" ? event.input?.path : event.input?.cwd;
  if (typeof cwd !== "string" || event.input?.async === true) return undefined;
  if (typeof elsewhere === "string" && elsewhere && !within(cwd, elsewhere)) return undefined;
  let sessionId;
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  return { session_id: sessionId, cwd, tool_name: toolName, tool_input: { [key]: value } };
}
