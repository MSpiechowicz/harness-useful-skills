import { readFileSync } from "node:fs";
import path from "node:path";

import { migrateDataDirectory } from "../data-migration.js";
import { GENERATED_MARKER, ROLE_AGENTS, ROLES, readOptional, syncRoleAgents, writeAtomic } from "../model-roles.js";
import { DATA_DIRECTORY } from "../names.js";
import { RUNTIME_ROOT, writeTargetProblem } from "./paths.js";

/** OpenCode reasoning variants; any other `:suffix` is part of the model ID (such as `ollama/llama3:8b`). */
export const VARIANTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9](?:[A-Za-z0-9._:/@+-]{0,198}[A-Za-z0-9._@+-])?$/;
const TEMPLATE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const RESERVED_FIELD = /^(model|variant):/m;

const HEADER = [
  "# Useful Skills model roles for OpenCode.",
  "# Selector: <provider>/<model>[:<variant>], for example anthropic/claude-sonnet-4-5:high.",
  `# Variant: ${VARIANTS.join(", ")}; any other \`:suffix\` stays part of the model ID.`,
  "# Every role inherits the session model. Replace `inherit` with a selector to give a role its own model.",
  "# `default` applies only to a role whose row is removed, except `assess`, which then inherits.",
  "# Changes apply to OpenCode sessions started afterwards.",
  "modelRoles:",
];

/** Every role listed and inheriting, so each one is a value to replace rather than a key to look up. */
const DEFAULT_CONFIG = [...HEADER, ...ROLES.map(role => `  ${role}: inherit`), ""].join("\n");

/** The role-less file earlier releases wrote; an untouched copy of it is replaced by DEFAULT_CONFIG. */
const LEGACY_DEFAULT_CONFIG = [
  "# Useful Skills model roles for OpenCode.",
  "# Selector: <provider>/<model>[:<variant>], for example anthropic/claude-sonnet-4-5:high.",
  `# Variant: ${VARIANTS.join(", ")}; any other \`:suffix\` stays part of the model ID.`,
  "# `inherit` uses the session model. Roles: research, frontend, backend, implementation, review, security, plan, default.",
  "# A missing role uses `default`; without `default` the agent inherits the session model.",
  "# Example rows (indent two spaces under modelRoles:):",
  "#   default: anthropic/claude-sonnet-4-5",
  "#   review: openai/gpt-5:high",
  "# Changes apply to OpenCode sessions started afterwards.",
  "modelRoles:",
  "",
].join("\n");

export function modelsConfigPath(scopeRoot) {
  return path.join(scopeRoot, DATA_DIRECTORY, "models.yml");
}

export function generatedAgentName(agent) {
  return `us-${agent}`;
}

export function generatedAgentPath(scopeRoot, agent) {
  return path.join(scopeRoot, "agents", `${generatedAgentName(agent)}.md`);
}

/**
 * Parse one `<provider>/<model>[:<variant>]` selector (or `inherit`), or throw a message naming the role.
 * Returns `{ model, variant }` with `model` null for inherit and `variant` undefined when absent.
 */
export function parseOpenCodeSelector(role, raw) {
  if (raw === "inherit") {
    return { model: null, variant: undefined };
  }

  const separator = raw.lastIndexOf(":");
  const suffix = separator >= 0 ? raw.slice(separator + 1) : undefined;
  const variant = VARIANTS.includes(suffix) ? suffix : undefined;
  const selector = variant ? raw.slice(0, separator) : raw;

  const slash = selector.indexOf("/");
  const provider = selector.slice(0, slash);
  const model = selector.slice(slash + 1);
  if (slash <= 0 || !PROVIDER.test(provider) || !MODEL.test(model)) {
    throw new Error(`Invalid selector for role "${role}". Use <provider>/<model>[:<variant>], for example anthropic/claude-sonnet-4-5:high.`);
  }

  return { model: selector, variant };
}

/** Split a bundled agent template into its frontmatter lines and body. */
function agentTemplate(agent, templatesDir) {
  const match = TEMPLATE.exec(readFileSync(path.join(templatesDir, `${agent}.md`), "utf8"));
  if (!match) {
    throw new Error(`Bundled OpenCode agent ${agent} has no frontmatter.`);
  }

  if (RESERVED_FIELD.test(match[1])) {
    throw new Error(`Bundled OpenCode agent ${agent} must not set a model or variant.`);
  }

  return { frontmatter: match[1], body: match[2] };
}

/** The generated agent: the template frontmatter plus a marker comment and the configured model and variant. */
export function renderOpenCodeAgent(agent, selection, { templatesDir, configFile }) {
  const { frontmatter, body } = agentTemplate(agent, templatesDir);
  // JSON strings are valid YAML scalars, so quoting keeps any model ID (with `:` or `@`) strictly valid.
  const model = selection.model ? [`model: ${JSON.stringify(selection.model)}`] : [];
  const variant = selection.model && selection.variant ? [`variant: ${selection.variant}`] : [];

  return [
    "---",
    `${GENERATED_MARKER} from ${JSON.stringify(configFile)} (role: ${ROLE_AGENTS[agent]}). Edit that file instead; this file is overwritten.`,
    frontmatter,
    ...model,
    ...variant,
    "---",
    body,
  ].join("\n");
}

/**
 * The first reason the sync must not write under `scopeRoot`, if any. Runs at every session start, so it applies the
 * installer's rules: no symlinked or non-directory component under the scope root, and no non-regular target file.
 */
function blockedWrite(scopeRoot) {
  const targets = [path.join(DATA_DIRECTORY, "models.yml"), ...Object.keys(ROLE_AGENTS).map(agent => path.join("agents", `${generatedAgentName(agent)}.md`))];
  for (const target of targets) {
    const problem = writeTargetProblem(scopeRoot, target.split(path.sep).join("/"));
    if (problem) return problem;
  }

  return undefined;
}

/**
 * Create the models file on first use and regenerate `<scopeRoot>/agents/us-<agent>.md` from the bundled templates.
 * Never overwrites an agent file Useful Skills did not generate, and writes nothing when a path under the scope root is
 * a symlink or not a real directory (`{ blocked }` names the path). Returns the model-roles.js syncRoleAgents result.
 */
export function syncOpenCodeAgents({ scopeRoot, templatesDir = path.join(RUNTIME_ROOT, "opencode", "agents") } = {}) {
  const configFile = modelsConfigPath(scopeRoot);
  const blocked = blockedWrite(scopeRoot);
  if (blocked) {
    return { configFile, created: false, blocked, agents: {} };
  }

  // A models file saved under the name used before the rename moves first, so the checks below see it.
  migrateDataDirectory(scopeRoot);

  // Only a byte-for-byte copy of the old default is replaced: an edited file stays as the user wrote it.
  if (readOptional(configFile) === LEGACY_DEFAULT_CONFIG) {
    writeAtomic(configFile, DEFAULT_CONFIG);
  }

  return syncRoleAgents({
    configFile,
    agentFile: agent => generatedAgentPath(scopeRoot, agent),
    defaultConfig: DEFAULT_CONFIG,
    parseSelector: parseOpenCodeSelector,
    render: (agent, selection) => renderOpenCodeAgent(agent, selection, { templatesDir, configFile }),
    fallback: { model: null, variant: undefined },
  });
}

function describe({ model, variant }) {
  if (!model) {
    return "inherits the session model";
  }

  return variant ? `${model}, variant ${variant}` : model;
}

/** Session context naming the configured model of each `us-*` agent and any file that needs attention. */
export function openCodeRoutingContext(result) {
  const lines = [`Useful Skills model roles for OpenCode are configured in ${result.configFile}${result.created ? " (created this session; every agent inherits the session model)" : ""}.`];
  if (result.blocked) {
    lines.push(`Role agents were not generated or updated: ${result.blocked}. Previously generated \`us-*\` agents keep their earlier models. Tell the user once so they can fix it.`);
    return lines.join("\n");
  }

  if (result.error) {
    lines.push(`That file is invalid: ${result.error} Role agents were not regenerated; previously generated \`us-*\` agents keep their earlier models. Tell the user once so they can fix the file.`);
    return lines.join("\n");
  }

  const pending = [];
  for (const [agent, info] of Object.entries(result.agents)) {
    const name = generatedAgentName(agent);
    if (info.state === "conflict") {
      lines.push(`- \`${name}\`: ${info.file} was not generated by Useful Skills, so it was left unchanged and its own definition applies.`);
      continue;
    }

    lines.push(`- \`${name}\`: ${describe(info.selection)}.`);
    if (info.state !== "ready") {
      pending.push(name);
    }
  }

  lines.push("Dispatch these agents with the `task` tool by `subagent_type` only; do not pass a model.");
  if (pending.length) {
    lines.push(`Created or updated this session (OpenCode loads them after a restart): ${pending.join(", ")}.`);
  }

  return lines.join("\n");
}
