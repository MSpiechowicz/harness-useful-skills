import assert from "node:assert/strict";
import test from "node:test";
import * as claude from "../claude/context.js";
import * as opencode from "../opencode/context.js";
import { createWorkflowContext } from "../workflow-context.js";
import { STAGES } from "../workflow-settings.js";

const STATES = ["enabled", "disabled", "unknown"];

function policy(workflow, stageState = () => "enabled") {
  return {
    workflow: { effective: workflow },
    stages: Object.fromEntries(STAGES.map((stage, index) => [stage, { effective: stageState(stage, index) }])),
  };
}

/** Every workflow state with a spread of mixed stage states. */
function policies() {
  const all = [];
  for (const workflow of STATES) {
    for (let offset = 0; offset < STATES.length; offset += 1) {
      all.push(policy(workflow, (stage, index) => STATES[(index + offset) % STATES.length]));
    }
  }
  return all;
}

test("each host names skills its own way and nothing else differs", () => {
  const ignoreClaude = "An attested native invocation of `harness-useful-skills:us-ignore-workflow`";
  const ignoreOpenCode = "A user-run `/us-ignore-workflow` command";

  for (const current of policies()) {
    const claudeText = claude.workflowContext(current);
    const opencodeText = opencode.workflowContext(current);
    assert.doesNotMatch(opencodeText, /harness-useful-skills:/);
    assert.equal(claudeText.replace(ignoreClaude, ignoreOpenCode).replaceAll("harness-useful-skills:", ""), opencodeText);
  }
  assert.equal(claude.fastLaneContext(), opencode.fastLaneContext());
});

test("a disabled workflow is the fast lane and an unknown one runs no stage or skill", () => {
  const context = createWorkflowContext({ skill: name => `host:${name}`, ignoreInvocation: "Opt-out" });

  assert.equal(context.workflowContext(policy("disabled")), context.fastLaneContext());
  const unknown = context.workflowContext(policy("unknown"));
  assert.notEqual(unknown, context.fastLaneContext());
  assert.doesNotMatch(unknown, /host:|Automatic/);
});

test("an enabled workflow gives one line per stage and points enabled stages at their host skill", () => {
  const context = createWorkflowContext({ skill: name => `host:${name}`, ignoreInvocation: "Opt-out" });
  const lines = context.workflowContext(policy("enabled", (stage, index) => STATES[index % STATES.length])).split("\n");
  const stageLines = lines.filter(line => line.startsWith("Automatic "));

  assert.equal(stageLines.length, STAGES.length);
  assert.match(lines[0], /`host:us-run-workflow`/);
  assert.match(lines[0], /Opt-out supplies the one-request exception/);
  for (const [index, stage] of STAGES.entries()) {
    const state = STATES[index % STATES.length];
    const line = stageLines[index];
    assert.ok(line.startsWith(`Automatic ${stage} stage`));
    assert.equal(/`host:us-[a-z-]+`/.test(line), state === "enabled", line);
  }
});

test("an enabled backend-memory stage points at Harness Memory before Useful Skills memory", () => {
  const context = createWorkflowContext({ skill: name => `host:${name}`, ignoreInvocation: "Opt-out" });
  const line = context.workflowContext(policy("enabled")).split("\n").find(text => text.startsWith("Automatic backend-memory"));

  assert.match(line, /Harness Memory: when its `note_search` and `note_save` tools are available, follow `host:us-use-harness-memory`/);
  assert.match(line, /Only without those tools consult `host:us-manage-memory`/);
});
