#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { effectiveWorkflow } from "../workflow-policy.js";
import { dangerousCommandReason, redactText } from "../resources.js";
import { fastLaneContext, workflowContext } from "./context.js";
import { readClaudeSettings } from "./settings.js";

const IGNORE_SKILL = "useful-skills:us-ignore-workflow";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const INVALID_INPUT = "Useful Skills hook received invalid event input.";

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
function directIgnoreInvocation(input) {
  return input.expansion_type === "slash_command"
    && input.command_source === "plugin"
    && input.command_name === IGNORE_SKILL;
}

function redactValue(value) {
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

/** A hook response, or undefined to leave normal Claude processing unchanged. */
export function handleHook(input, environment = process.env) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      const policy = effectiveWorkflow(readClaudeSettings(environment));
      return additionalContext("UserPromptSubmit", workflowContext(policy));
    }
    case "UserPromptExpansion": {
      if (!directIgnoreInvocation(input)) {
        return undefined;
      }
      const policy = effectiveWorkflow(readClaudeSettings(environment), { explicitOptOut: true });
      const text = policy.workflow.effective === "disabled" ? fastLaneContext() : workflowContext(policy);
      return additionalContext("UserPromptExpansion", text);
    }
    case "PreToolUse": {
      if (input.tool_name !== "Bash") {
        return undefined;
      }
      if (typeof input.tool_input?.command !== "string") {
        return deny(INVALID_INPUT);
      }
      const reason = dangerousCommandReason(input.tool_input.command);
      return reason ? deny(`Useful Skills safety guard: ${reason}. Use a reversible, explicitly approved operation instead.`) : undefined;
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

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) {
      throw new Error(INVALID_INPUT);
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
}

async function main() {
  const expected = process.argv[2];
  if (!["UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse"].includes(expected)) {
    process.exitCode = 2;
    return;
  }

  try {
    const input = await readInput();
    if (input?.hook_event_name !== expected) {
      throw new Error(INVALID_INPUT);
    }
    if (expected === "PreToolUse" && input.tool_name !== "Bash") {
      process.stdout.write(`${JSON.stringify(deny(INVALID_INPUT))}\n`);
      return;
    }
    const result = handleHook(input);
    if (result) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    if (expected === "PreToolUse") {
      process.stdout.write(`${JSON.stringify(deny(INVALID_INPUT))}\n`);
    } else if (expected === "UserPromptSubmit") {
      process.stdout.write(`${JSON.stringify(additionalContext(expected, workflowContext({ workflow: { effective: "unknown" } })))}\n`);
    } else {
      // No raw exception or input is included in hook diagnostics.
      process.exitCode = 2;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
