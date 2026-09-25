import { STAGES } from "./workflow-settings.js";

function savedState(snapshot, key) {
  if (snapshot?.errors?.[key] || typeof snapshot?.values?.[key] !== "boolean") {
    return "unknown";
  }

  return snapshot.values[key] ? "enabled" : "disabled";
}

export function effectiveWorkflow(snapshot, { explicitOptOut = false } = {}) {
  const savedWorkflow = savedState(snapshot, "workflow");
  const workflow = {
    saved: savedWorkflow,
    effective: explicitOptOut && savedWorkflow === "enabled" ? "disabled" : savedWorkflow,
  };
  const stages = Object.fromEntries(STAGES.map(stage => {
    const saved = savedState(snapshot, stage);
    let effective;

    if (saved === "disabled" || workflow.effective === "disabled") {
      effective = "disabled";
    } else if (saved === "unknown" || workflow.effective === "unknown") {
      effective = "unknown";
    } else {
      effective = "enabled";
    }

    return [stage, { saved, effective }];
  }));

  return { workflow, stages };
}
