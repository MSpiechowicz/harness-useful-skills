/**
 * Model roles for the Codex role agents: the `models.yml` in the Harness Skills folder of CODEX_HOME, which has the same
 * schema as the Claude and OpenCode files, and the `model` and `model_reasoning_effort` lines it adds to the generated
 * `agents/us-<role>.toml`. Runs in the installer and in the installed runtime (apply-models.js).
 */
import { ROLE_AGENTS, ROLES, parseModelsConfig, readConfigText, writeAtomic } from "../model-roles.js";
import { directoryProblem, lstatOrNull } from "../opencode/paths.js";
import { MODELS_REL, atHome } from "./paths.js";

/** Reasoning efforts Codex accepts for `model_reasoning_effort`; any other `:suffix` is part of the model ID. */
export const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]);

const MODEL = /^[A-Za-z0-9](?:[A-Za-z0-9._:/@+-]{0,198}[A-Za-z0-9._@+-])?$/;
const INHERIT = Object.freeze({ model: null, effort: undefined });

const HEADER = [
  "# Harness Skills model roles for Codex.",
  "# Selector: <model>[:<effort>], for example gpt-5.5:high. Effort: " + EFFORTS.join(", ") + ".",
  "# `inherit` uses the model and reasoning effort of your Codex setup, and `inherit:<effort>` changes only the effort.",
  "# Every role inherits. Replace `inherit` with a selector to give a role its own model.",
  "# `default` applies only to a role whose row is removed.",
  "# Changes apply to the agents once they are applied again (./useful-skills models apply --host codex) or the",
  "# installer runs again, and to Codex sessions started afterwards.",
  "modelRoles:",
];

/** Every role listed and inheriting, so each one is a value to replace rather than a key to look up. */
export const DEFAULT_MODELS = [...HEADER, ...ROLES.map(role => `  ${role}: inherit`), ""].join("\n");

/**
 * Parse one `<model>[:<effort>]` selector (or `inherit`), or throw a message naming the role.
 * Returns `{ model, effort }` with `model` null for inherit and `effort` undefined when absent.
 */
export function parseCodexSelector(role, raw) {
  const separator = raw.lastIndexOf(":");
  const suffix = separator >= 0 ? raw.slice(separator + 1) : undefined;
  const effort = EFFORTS.includes(suffix) ? suffix : undefined;
  const model = effort ? raw.slice(0, separator) : raw;

  if (model === "inherit") {
    return { model: null, effort };
  }

  if (!MODEL.test(model)) {
    throw new Error(`Invalid selector for role "${role}". Use <model>[:<effort>], for example gpt-5.5:high.`);
  }

  return { model, effort };
}

/**
 * Read the models file of a Codex home without writing anything. Returns `{ configFile, exists, roles }`, or
 * `{ configFile, exists, error }` when the file cannot be used. A missing file reads as the defaults.
 */
export function readCodexModels(codexHome) {
  const configFile = atHome(codexHome, MODELS_REL);

  const blocked = directoryProblem(codexHome, MODELS_REL);
  if (blocked) {
    return { configFile, exists: false, error: blocked };
  }

  const found = lstatOrNull(configFile);
  if (found && !found.isFile()) {
    return { configFile, exists: true, error: `${configFile} is ${found.isSymbolicLink() ? "a symbolic link" : "not a regular file"}` };
  }

  try {
    const text = found ? readConfigText(configFile) : DEFAULT_MODELS;
    return { configFile, exists: Boolean(found), roles: parseModelsConfig(text, parseCodexSelector) };
  } catch (error) {
    return { configFile, exists: Boolean(found), error: error.message };
  }
}

/** Create the models file with the defaults when it does not exist; an existing file is never rewritten. */
export function ensureCodexModels(models) {
  if (models.exists || models.error) {
    return false;
  }

  writeAtomic(models.configFile, DEFAULT_MODELS);
  return true;
}

/** The selection for a plugin agent (`planner`): its role's row, else `default`, else inherit. */
export function selectionFor(agent, roles) {
  return roles[ROLE_AGENTS[agent]] ?? roles.default ?? INHERIT;
}

/** Add the selection to a generated agent file: `model` and `model_reasoning_effort` follow `description`, unset ones are omitted. */
export function renderCodexAgent(text, selection) {
  const lines = text.split("\n");
  const added = [
    ...(selection.model ? [`model = ${JSON.stringify(selection.model)}`] : []),
    ...(selection.effort ? [`model_reasoning_effort = ${JSON.stringify(selection.effort)}`] : []),
  ];

  return [...lines.slice(0, 3), ...added, ...lines.slice(3)].join("\n");
}

/** Human-readable selection, as in `gpt-5.5, effort high` or `inherits the Codex setting`. */
export function describeSelection({ model, effort }) {
  if (!model && !effort) {
    return "inherits the Codex setting";
  }

  return [model ?? "the Codex model", effort ? `effort ${effort}` : undefined].filter(Boolean).join(", ");
}
