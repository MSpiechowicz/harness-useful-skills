#!/usr/bin/env node
import { invokedDirectly } from "../entrypoint.js";
import { codeHint, searchTerm } from "../code-hint.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { commandGuardDenial, INVALID_TOOL_INPUT, redactValue } from "../tool-safety.js";
import { fastLaneContext, workflowContext } from "./context.js";
import { claudeConfigDir, modelRoutingContext, syncRoleAgents } from "./models.js";
import { readClaudeSettings, readClaudeWorkflow } from "./settings.js";

const IGNORE_SKILL = "harness-useful-skills:us-ignore-workflow";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MODELS_UNAVAILABLE = "Useful Skills could not read or write its Claude model-role configuration. Dispatch the `harness-useful-skills:<agent>` subagents named by the skills; they inherit the session model.";

function additionalContext(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Only the host's command-expansion metadata can attest direct skill invocation. */
export function directIgnoreInvocation(input) {
  return input.expansion_type === "slash_command"
    && input.command_source === "plugin"
    && input.command_name === IGNORE_SKILL;
}

/**
 * A hook response, or undefined to leave normal Claude processing unchanged.
 * `settings` is a pre-read workflow snapshot; without it prompt hooks use plugin options only.
 */
export function handleHook(input, environment = process.env, { settings } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  switch (input.hook_event_name) {
    case "SessionStart": {
      // Role agents are generated outside the plugin because plugin agent frontmatter cannot read user options.
      return additionalContext("SessionStart", modelRoutingContext(syncRoleAgents({ configDir: claudeConfigDir(environment) })));
    }
    case "UserPromptSubmit": {
      const policy = effectiveWorkflow(settings ?? readClaudeSettings(environment));
      return additionalContext("UserPromptSubmit", workflowContext(policy));
    }
    case "UserPromptExpansion": {
      if (!directIgnoreInvocation(input)) {
        return undefined;
      }
      const policy = effectiveWorkflow(settings ?? readClaudeSettings(environment), { explicitOptOut: true });
      const text = policy.workflow.effective === "disabled" ? fastLaneContext() : workflowContext(policy);
      return additionalContext("UserPromptExpansion", text);
    }
    case "PreToolUse": {
      if (input.tool_name !== "Bash") {
        // Grep is only nudged (see main), never guarded.
        return undefined;
      }
      const denial = commandGuardDenial(input.tool_input?.command);
      return denial ? deny(denial) : undefined;
    }
    case "PostToolUse": {
      if (!Object.hasOwn(input, "tool_response")) {
        return undefined;
      }
      const redacted = redactValue(input.tool_response);
      return redacted === input.tool_response ? undefined : {
        hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted },
      };
    }
    default:
      return undefined;
  }
}

/** The raw stdin text, truncated at the size limit (`oversized` is then true). */
async function readText() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) {
      return { text: Buffer.concat(chunks).toString("utf8"), oversized: true };
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks, length).toString("utf8"), oversized: false };
}

/** Whether unparsable PreToolUse input is positively a Grep call: a nudge hook must never block a search. */
const isGrepCall = (text) => /"tool_name"\s*:\s*"Grep"/.test(text);

/** Nudge toward the code tools on an identifier search. Silent on every failure and when the code-graph stage is off. */
async function writeSearchHint(input) {
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!dataDir || !searchTerm(input)) {
      return;
    }
    const policy = effectiveWorkflow(await readClaudeWorkflow({ environment: process.env, cwd: input.cwd }));
    const hint = await codeHint(input, { enabled: policy.stages["code-graph"]?.effective === "enabled", dataDir });
    if (hint) {
      process.stdout.write(`${JSON.stringify(additionalContext("PreToolUse", hint))}\n`);
    }
  } catch {
    // A hint is never worth failing a tool call.
  }
}

async function main() {
  const expected = process.argv[2];
  if (!["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse"].includes(expected)) {
    process.exitCode = 2;
    return;
  }

  let raw = { text: "", oversized: false };
  try {
    raw = await readText();
    if (raw.oversized) {
      throw new Error(INVALID_TOOL_INPUT);
    }
    const input = JSON.parse(raw.text);
    if (input?.hook_event_name !== expected) {
      throw new Error(INVALID_TOOL_INPUT);
    }
    if (expected === "PreToolUse" && input.tool_name !== "Bash" && input.tool_name !== "Grep") {
      process.stdout.write(`${JSON.stringify(deny(INVALID_TOOL_INPUT))}\n`);
      return;
    }

    // Saved repository/profile settings are read only for hooks that report workflow state.
    let settings;
    if (expected === "UserPromptSubmit" || (expected === "UserPromptExpansion" && directIgnoreInvocation(input))) {
      settings = await readClaudeWorkflow({ environment: process.env, cwd: input.cwd });
    }

    const result = handleHook(input, process.env, { settings });
    if (!result && expected === "PreToolUse") {
      await writeSearchHint(input);
      return;
    }
    if (result) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    if (expected === "PreToolUse") {
      // Only the dangerous-command guard fails closed. A Grep call that cannot be read is let through silently.
      if (!isGrepCall(raw.text)) {
        process.stdout.write(`${JSON.stringify(deny(INVALID_TOOL_INPUT))}\n`);
      }
    } else if (expected === "SessionStart") {
      process.stdout.write(`${JSON.stringify(additionalContext(expected, MODELS_UNAVAILABLE))}\n`);
    } else if (expected === "UserPromptSubmit") {
      process.stdout.write(`${JSON.stringify(additionalContext(expected, workflowContext({ workflow: { effective: "unknown" } })))}\n`);
    } else {
      // No raw exception or input is included in hook diagnostics.
      process.exitCode = 2;
    }
  }
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
