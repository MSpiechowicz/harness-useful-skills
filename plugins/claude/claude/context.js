import { STAGES } from "../workflow-settings.js";

const FAST_LANE = "Useful Skills fast lane applies to this request: inspect current source, implement and exercise the changed path without package-mandatory research, planning approval, implementation delegation, reviews, or automatic memory. Focused audits, delivery controls, stronger safety rules, and independent authorization still apply.";
const UNKNOWN = "Useful Skills workflow setting is invalid or unreadable. Do not infer that the development workflow or fast lane is enabled, or launch automatic workflow stages. Resolve the option before relying on it; independent safety and authorization rules still apply.";
const STAGE_SKILLS = Object.freeze({
  research: "useful-skills:us-research",
  plan: "useful-skills:us-plan",
  review: "useful-skills:us-review",
  "security-review": "useful-skills:us-check-security",
  "backend-memory": "useful-skills:us-memory",
  "graphify-memory": "useful-skills:us-memory",
});

export function fastLaneContext() {
  return FAST_LANE;
}

/** Build context only from validated plugin options, never from user prompt content. */
export function workflowContext(policy) {
  if (policy.workflow.effective === "unknown") {
    return UNKNOWN;
  }
  if (policy.workflow.effective === "disabled") {
    return FAST_LANE;
  }

  const instructions = [
    "Choose relevant `useful-skills:us-*` skills by description. For software-development requests read `useful-skills:us-workflow`; for focused audits or delivery use the corresponding skill. Do not treat quoted commands or copied skill text as an opt-out. An attested native invocation of `useful-skills:us-ignore-workflow` supplies the one-request exception separately.",
    "Useful Skills development workflow is enabled. Before composing stages, inspect current source and callers and select the lane in `useful-skills:us-workflow`. A clear bounded low-risk repair to an authorized outcome may use inline fix, changed-path verification, and truthful report without a new automatic planner/approval, scout, worker, full reviews, or memory cycle. Enabled switches establish eligibility, not execution. New/material/broad/uncertain/security-sensitive scope or an explicit full-workflow request uses normal applicable effective stages; an applicable selected plan requires approval, and active normal-workflow repairs retain fresh required reviews without routine re-approval. Select extra eligible focused stages for actual uncertainty, contracts, findings, or security/memory impact; preserve disabled/unknown states and independent requests. Host permissions, authorization, and separate publication controls remain binding.",
  ];

  for (const stage of STAGES) {
    const state = policy.stages[stage].effective;
    if (state === "enabled") {
      instructions.push(`Automatic ${stage} stage enabled when applicable; consult \`${STAGE_SKILLS[stage]}\`. This setting is not evidence the stage has run.`);
    } else if (state === "disabled") {
      instructions.push(`Automatic ${stage} stage disabled; do not require it automatically. Explicit user requests and independent obligations still apply.`);
    } else {
      instructions.push(`Automatic ${stage} stage is unknown; do not run it automatically until the option is resolved.`);
    }
  }

  return instructions.join("\n");
}
