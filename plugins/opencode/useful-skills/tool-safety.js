import { dangerousCommandReason, redactText } from "./resources.js";

export const INVALID_TOOL_INPUT = "Useful Skills hook received invalid event input.";

/** The reason to deny a shell command, or undefined to allow it. A non-string command is always denied. */
export function commandGuardDenial(command) {
  if (typeof command !== "string") {
    return INVALID_TOOL_INPUT;
  }

  const reason = dangerousCommandReason(command);
  return reason ? `Useful Skills safety guard: ${reason}. Use a reversible, explicitly approved operation instead.` : undefined;
}

/** Redact secrets in every string of a tool result. Returns the same value when nothing changed. */
export function redactValue(value) {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const redacted = redactValue(item);
      changed ||= redacted !== item;
      return redacted;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      // Image data is not a text result. Keep its encoded payload intact.
      const redacted = key === "data" && value.type === "image" ? entry : redactValue(entry);
      next[key] = redacted;
      changed ||= redacted !== entry;
    }
    return changed ? next : value;
  }
  return value;
}
