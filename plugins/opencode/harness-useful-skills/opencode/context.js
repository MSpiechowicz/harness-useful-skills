import { createWorkflowContext } from "../workflow-context.js";

// OpenCode loads skills by their bare `us-*` names through the `skill` tool.
const opencode = createWorkflowContext({
  skill: name => name,
  ignoreInvocation: "A user-run `/us-ignore-workflow` command",
});

export function fastLaneContext() {
  return opencode.fastLaneContext();
}

/** Build context only from validated settings, never from user prompt content. */
export function workflowContext(policy) {
  return opencode.workflowContext(policy);
}
