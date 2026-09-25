import { STAGES } from "../workflow-settings.js";

const OPTION_KEYS = Object.freeze({
  workflow: "WORKFLOW",
  research: "RESEARCH",
  plan: "PLAN",
  review: "REVIEW",
  "security-review": "SECURITY_REVIEW",
  "backend-memory": "BACKEND_MEMORY",
  "graphify-memory": "GRAPHIFY_MEMORY",
});

/** Claude exports boolean userConfig values as strings to hook processes. */
export function readClaudeSettings(environment = process.env) {
  const values = {};
  const errors = {};

  for (const key of ["workflow", ...STAGES]) {
    const option = `CLAUDE_PLUGIN_OPTION_${OPTION_KEYS[key]}`;
    const raw = environment[option];
    if (raw === undefined) {
      values[key] = true;
    } else if (raw === "true") {
      values[key] = true;
    } else if (raw === "false") {
      values[key] = false;
    } else {
      values[key] = undefined;
      errors[key] = "Invalid Claude plugin boolean option.";
    }
  }

  return { values, errors };
}
