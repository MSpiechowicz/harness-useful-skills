import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleHook } from "../claude/hooks.js";
import { readClaudeSettings } from "../claude/settings.js";
import { effectiveWorkflow } from "../workflow-policy.js";

const script = fileURLToPath(new URL("../claude/hooks.js", import.meta.url));
const normal = { CLAUDE_PLUGIN_OPTION_WORKFLOW: "true", OMP_ECC_SAFETY: "true" };
const SECRET = "pass" + "word=" + "synthetic-example-value-12345";

function context(event, environment = normal) {
  return handleHook(event, environment)?.hookSpecificOutput?.additionalContext;
}

function run(event, payload, environment = normal) {
  return spawnSync(process.execPath, [script, event], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

test("native boolean switches independently gate workflow stages; malformed options never enable a mode", () => {
  const disabled = readClaudeSettings({
    CLAUDE_PLUGIN_OPTION_PLAN: "false",
    CLAUDE_PLUGIN_OPTION_SECURITY_REVIEW: "false",
    CLAUDE_PLUGIN_OPTION_GRAPHIFY_MEMORY: "false",
  });
  const policy = effectiveWorkflow(disabled);
  assert.equal(policy.stages.plan.effective, "disabled");
  assert.equal(policy.stages["security-review"].effective, "disabled");
  assert.equal(policy.stages["graphify-memory"].effective, "disabled");
  assert.equal(policy.stages.research.effective, "enabled");
  assert.equal(policy.stages.review.effective, "enabled");
  assert.equal(policy.stages["backend-memory"].effective, "enabled");

  const malformed = effectiveWorkflow(readClaudeSettings({
    CLAUDE_PLUGIN_OPTION_WORKFLOW: "yes",
    CLAUDE_PLUGIN_OPTION_REVIEW: "enabled",
  }));
  assert.equal(malformed.workflow.effective, "unknown");
  assert.equal(malformed.stages.review.effective, "unknown");
  assert.equal(malformed.stages.plan.effective, "unknown");
  const message = context({ hook_event_name: "UserPromptSubmit", prompt: "Build it" }, {
    CLAUDE_PLUGIN_OPTION_WORKFLOW: "yes",
  });
  assert.match(message, /setting is invalid or unreadable/);
  assert.doesNotMatch(message, /fast lane applies/);

  const masterOff = effectiveWorkflow(readClaudeSettings({
    CLAUDE_PLUGIN_OPTION_WORKFLOW: "false",
    CLAUDE_PLUGIN_OPTION_REVIEW: "invalid",
  }));
  assert.equal(masterOff.stages.review.effective, "disabled");
});

test("only an attested direct plugin skill expansion opts this request out", () => {
  const submitted = context({
    hook_event_name: "UserPromptSubmit",
    prompt: "Please document `/useful-skills:us-ignore-workflow`, do not invoke it.",
  });
  assert.match(submitted, /development workflow is enabled/);
  assert.doesNotMatch(submitted, /fast lane applies to this request/);

  const direct = {
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_source: "plugin",
    command_name: "useful-skills:us-ignore-workflow",
    command_args: "fix bug",
  };
  assert.match(context(direct), /fast lane applies to this request/);
  assert.equal(context({ ...direct, command_source: "project" }), undefined);
  assert.equal(context({ ...direct, expansion_type: "mcp_prompt" }), undefined);
  assert.equal(context({ ...direct, command_name: "other-skill" }), undefined);
  assert.match(context(direct, { CLAUDE_PLUGIN_OPTION_WORKFLOW: "bad" }), /setting is invalid or unreadable/);
});

test("Bash hook denies dangerous commands without copying untrusted input and leaves safe permission flow alone", () => {
  const base = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  const rejected = handleHook({
    ...base,
    tool_input: { command: `rm -rf / && echo ${SECRET}` },
  }, normal)?.hookSpecificOutput;
  assert.equal(rejected.permissionDecision, "deny");
  assert.equal(handleHook({ ...base, tool_input: { command: "printf 'hello'" } }, normal), undefined);
  assert.equal(handleHook({ ...base, tool_input: {} }, normal)?.hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(rejected.permissionDecisionReason, /synthetic-example-value-12345/);
  assert.equal(handleHook({ ...base, tool_input: { command: "rm -rf /" } }, {
    ...normal, OMP_ECC_SAFETY: "off",
  })?.hookSpecificOutput.permissionDecision, "deny");
});

test("Bash PreToolUse denies recursive removal of literal catastrophic and dynamic targets", () => {
  const base = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  for (const command of [
    'rm -rf "$HOME"',
    "rm -rf ${HOME}",
    "rm -f -r ${HOME}",
    'rm -r -f "$HOME"',
    'rm -rf --no-preserve-root "/"',
    "rm --recursive -f '/'",
    "rm --recursive ${HOME}",
    'rm -f -r "/"',
    "rm -f -r /",
    "rm -f -r ~",
    "rm -f -r .",
    "rm -rf $(printf /)",
    "rm -rf `pwd`",
    "rm -rf *",
  ]) {
    const response = handleHook({ ...base, tool_input: { command } }, normal);
    assert.equal(response?.hookSpecificOutput.permissionDecision, "deny", command);
  }
  for (const command of [
    'rm -rf "node_modules"',
    'rm -rf "./build"',
    "rm -f -r node_modules",
    "rm -f -r build/",
    "rm -rf build/",
    "rm --version '$HOME'",
    "rm --preserve-root '$HOME'",
  ]) {
    assert.equal(handleHook({ ...base, tool_input: { command } }, normal), undefined, command);
  }
});

test("PostToolUse redacts supported text-bearing result fields without changing result structure", () => {
  const response = {
    stdout: SECRET,
    stderr: "Authorization: Bearer " + "synthetic-example-value-12345",
    interrupted: false,
    isImage: false,
  };
  const result = handleHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: response })?.hookSpecificOutput;
  assert.equal(result.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(result.updatedToolOutput), Object.keys(response));
  assert.deepEqual([result.updatedToolOutput.interrupted, result.updatedToolOutput.isImage], [false, false]);
  assert.equal(result.updatedToolOutput.stdout, "password=[REDACTED]");
  assert.equal(result.updatedToolOutput.stderr, "Authorization: Bearer [REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-example-value-12345/);

  const mcp = { content: [
    { type: "text", text: response.stdout },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ], isError: false };
  const redacted = handleHook({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_useful-skills_useful_skills__memory_search", tool_response: mcp })?.hookSpecificOutput.updatedToolOutput;
  assert.equal(redacted.content[0].type, "text");
  assert.equal(redacted.content[0].text, "password=[REDACTED]");
  assert.equal(redacted.content[1], mcp.content[1]);
  assert.equal(redacted.isError, false);
  assert.equal(handleHook({ hook_event_name: "PostToolUse", tool_response: { stdout: "safe", interrupted: false } }), undefined);
  assert.equal(handleHook({ hook_event_name: "PostToolUseFailure", tool_response: response }), undefined);
});

test("executable consumes JSON stdin and emits only valid decision JSON with sanitized failures", () => {
  const prompt = run("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "hello" });
  assert.equal(prompt.status, 0);
  assert.equal(prompt.stderr, "");
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");

  const denied = run("PreToolUse", {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" },
  });
  const safe = run("PreToolUse", {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "printf 'hello'" },
  });
  assert.equal(safe.status, 0);
  assert.equal(safe.stdout, "");
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const secret = SECRET;
  const malformed = run("PreToolUse", `{"hook_event_name":"PreToolUse","command":"${secret}"`);
  assert.equal(malformed.status, 0);
  assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(malformed.stdout + malformed.stderr, /synthetic-example-value-12345/);

  const result = run("PostToolUse", {
    hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_response: { stdout: secret, stderr: "", interrupted: false, isImage: false },
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-example-value-12345/);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput.stdout, "password=[REDACTED]");
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput.interrupted, false);
});
