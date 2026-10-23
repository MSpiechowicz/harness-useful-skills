import { createWorkflowContext } from "../workflow-context.js";

const claude = createWorkflowContext({
  skill: name => `harness-useful-skills:${name}`,
  ignoreInvocation: "An attested native invocation of `harness-useful-skills:us-ignore-workflow`",
});

export function fastLaneContext() {
  return claude.fastLaneContext();
}

/** Build context only from validated plugin options, never from user prompt content. */
export function workflowContext(policy) {
  return claude.workflowContext(policy);
}
