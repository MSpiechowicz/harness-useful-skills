import { lstatSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legacyClaudeAgentFile } from "../legacy-names.js";
import { GENERATED_MARKER, isGeneratedAgent, parseModelsConfig as parseRolesConfig, ROLE_AGENTS, ROLES, syncRoleAgents as syncRoles } from "../model-roles.js";
import { DATA_DIRECTORY, PLUGIN_NAME } from "../names.js";

export { ROLE_AGENTS, ROLES };

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL = /^(inherit|opus|sonnet|haiku|fable|claude-[a-z0-9][a-z0-9.-]{0,80})$/;

export const DEFAULT_ROLES = Object.freeze({
  research: "claude-haiku-5-5:high",
  frontend: "claude-sonnet-5-5:high",
  backend: "claude-opus-5-5:high",
  implementation: "claude-sonnet-5-5:high",
  review: "claude-sonnet-5-5:medium",
  security: "claude-opus-5-5:high",
  plan: "claude-opus-5-5:high",
  default: "claude-opus-5-5:medium",
});

export function claudeConfigDir(environment = process.env) {
  return environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function modelsConfigPath(configDir) {
  return path.join(configDir, DATA_DIRECTORY, "models.yml");
}

export function generatedAgentName(agent) {
  return `us-${agent}`;
}

function agentFile(configDir, agent) {
  return path.join(configDir, "agents", `${PLUGIN_NAME}-${agent}.md`);
}

function defaultConfig() {
  const rows = ROLES.map(role => `  ${role}: ${DEFAULT_ROLES[role]}`);
  return [
    "# Useful Skills model roles for Claude Code.",
    "# Selector: <model>[:<effort>]. Model is a Claude model ID or alias (opus, sonnet, haiku, fable, inherit);",
    "# an OMP-style \"anthropic/\" prefix is accepted. Effort: low, medium, high, xhigh, max.",
    "# A missing role uses `default`. Changes apply to Claude Code sessions started afterwards.",
    "modelRoles:",
    ...rows,
    "",
  ].join("\n");
}

/** Parse one `<model>[:<effort>]` selector, or throw a message naming the role. */
export function parseSelector(role, raw) {
  const [model, effort, extra] = raw.replace(/^anthropic\//, "").split(":");
  if (extra !== undefined || !MODEL.test(model) || (effort !== undefined && !EFFORTS.has(effort))) {
    throw new Error(`Invalid selector for role "${role}". Use <model>[:<effort>], for example claude-opus-5-5:high.`);
  }
  return { model, effort };
}

/** A strict YAML subset: comments, a `modelRoles:` key, and indented `role: <model>[:<effort>]` rows. */
export function parseModelsConfig(text) {
  return parseRolesConfig(text, parseSelector);
}

/** Split a bundled plugin agent into its simple frontmatter fields and body. */
function pluginAgent(agent, pluginRoot) {
  const text = readFileSync(path.join(pluginRoot, "claude", "agents", `${agent}.md`), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Bundled agent ${agent} has no frontmatter.`);
  const fields = Object.fromEntries(match[1].split("\n").map(row => {
    const separator = row.indexOf(":");
    return [row.slice(0, separator).trim(), row.slice(separator + 1).trim()];
  }));
  return { fields, body: match[2] };
}

export function renderAgent(agent, selection, { pluginRoot = PLUGIN_ROOT, configFile }) {
  const { fields, body } = pluginAgent(agent, pluginRoot);
  // Generated agents live outside the plugin, so plugin-relative references become absolute.
  const resolvedBody = body.replaceAll("the plugin's `claude/", `\`${path.join(pluginRoot, "claude")}/`);
  return [
    "---",
    `${GENERATED_MARKER} from ${configFile} (role: ${ROLE_AGENTS[agent]}). Edit that file instead; this file is overwritten.`,
    `name: ${generatedAgentName(agent)}`,
    `description: ${fields.description}`,
    `tools: ${fields.tools}`,
    `model: ${selection.model}`,
    ...(selection.effort ? [`effort: ${selection.effort}`] : []),
    "---",
    resolvedBody,
  ].join("\n");
}

/**
 * Create the model config on first use and regenerate the Claude role agents from it.
 * Never overwrites an agent file that Useful Skills did not generate.
 */
export function syncRoleAgents({ configDir = claudeConfigDir(), pluginRoot = PLUGIN_ROOT } = {}) {
  const configFile = modelsConfigPath(configDir);
  const result = syncRoles({
    configFile,
    agentFile: agent => agentFile(configDir, agent),
    defaultConfig: defaultConfig(),
    parseSelector,
    render: (agent, selection) => renderAgent(agent, selection, { pluginRoot, configFile }),
    fallback: { model: "inherit" },
  });

  removeLegacyAgents(configDir, result);
  return result;
}

/**
 * Remove the generated agents written under the file names used before the rename. They declare the same
 * `us-*` names as the current files, so both would load. A file Useful Skills did not generate is the user's and stays.
 */
function removeLegacyAgents(configDir, result) {
  if (result.error) {
    return;
  }

  for (const agent of Object.keys(ROLE_AGENTS)) {
    const file = path.join(configDir, "agents", legacyClaudeAgentFile(agent));
    try {
      if (lstatSync(file, { throwIfNoEntry: false })?.isFile() && isGeneratedAgent(readFileSync(file, "utf8"))) {
        rmSync(file);
      }
    } catch {
      // Left in place: the next session tries again.
    }
  }
}

function describe({ model, effort }) {
  return effort ? `${model}, effort ${effort}` : model;
}

/** Session context naming which agent to dispatch for each plugin role. */
export function modelRoutingContext(result) {
  const lines = [`Useful Skills model roles are configured in ${result.configFile}${result.created ? " (created with defaults this session)" : ""}.`];
  if (result.error) {
    lines.push(`That file is invalid: ${result.error} Role agents were not regenerated; previously generated \`us-*\` agents keep their earlier models. Tell the user once so they can fix the file.`);
  }
  const pending = [];
  for (const [agent, info] of Object.entries(result.agents)) {
    const plugin = `${PLUGIN_NAME}:${agent}`;
    if (info.state === "conflict") {
      lines.push(`- ${plugin}: ${info.file} exists but was not generated by Useful Skills; dispatch \`${plugin}\` (inherits the session model).`);
      continue;
    }
    lines.push(`- ${plugin}: dispatch \`${generatedAgentName(agent)}\` (${describe(info.selection)}).`);
    if (info.state !== "ready") pending.push(generatedAgentName(agent));
  }
  if (Object.keys(result.agents).length) {
    lines.unshift("When a Useful Skills skill names a `harness-useful-skills:<agent>` subagent, dispatch the configured role agent listed below with the same brief and boundaries; do not pass a `model` in the Agent call.");
    lines.push("If a listed `us-*` agent type is unavailable in this session, dispatch the named `harness-useful-skills:<agent>` instead and report that it ran on the inherited session model.");
  }
  if (pending.length) {
    lines.push(`Created or updated this session (load after Claude Code restarts): ${pending.join(", ")}.`);
  }
  return lines.join("\n");
}
