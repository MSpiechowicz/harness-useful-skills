import { STAGES, readWorkflowSnapshot } from "../workflow-settings.js";
import { claudeConfigDir } from "./models.js";

const KEYS = Object.freeze(["workflow", ...STAGES]);

const OPTION_KEYS = Object.freeze({
  workflow: "WORKFLOW",
  research: "RESEARCH",
  plan: "PLAN",
  review: "REVIEW",
  "security-review": "SECURITY_REVIEW",
  "backend-memory": "BACKEND_MEMORY",
  "graphify-memory": "GRAPHIFY_MEMORY",
});

function optionName(key) {
  return `CLAUDE_PLUGIN_OPTION_${OPTION_KEYS[key]}`;
}

/** Claude exports boolean userConfig values as strings to hook processes. */
export function readClaudeSettings(environment = process.env) {
  const values = {};
  const errors = {};

  for (const key of KEYS) {
    const option = optionName(key);
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

/**
 * Per key: an unreadable saved file stays unknown, a saved file wins, and only an
 * absent file falls back to the plugin userConfig option, then to enabled.
 */
export async function readClaudeWorkflow({ environment = process.env, cwd } = {}) {
  // The OMP-compatible file store under the Claude config dir.
  const store = await readWorkflowSnapshot({ configDir: claudeConfigDir(environment), cwd });
  const options = readClaudeSettings(environment);
  const values = {};
  const errors = {};
  const sources = {};

  for (const key of KEYS) {
    if (store.errors[key] || store.sources?.[key] === "error") {
      values[key] = undefined;
      errors[key] = store.errors[key] ?? "Cannot read workflow setting.";
      sources[key] = "error";
    } else if (store.sources?.[key] === "file") {
      values[key] = store.values[key];
      sources[key] = "file";
    } else if (environment[optionName(key)] !== undefined) {
      values[key] = options.values[key];
      sources[key] = "option";
      if (options.errors[key]) {
        errors[key] = options.errors[key];
      }
    } else {
      values[key] = true;
      sources[key] = "default";
    }
  }

  return {
    directory: store.directory,
    scopeRoot: store.scopeRoot,
    workflowFile: store.workflowFile,
    values,
    errors,
    sources,
  };
}
