import assert from "node:assert/strict";
import test from "node:test";
import { effectiveWorkflow } from "../workflow-policy.js";
import { STAGES } from "../workflow-settings.js";

function snapshot(overrides = {}, errors = {}) {
  return {
    values: { workflow: true, ...Object.fromEntries(STAGES.map(stage => [stage, true])), ...overrides },
    errors,
  };
}

test("independent stage choices survive master disable, request opt-out, and re-enable", () => {
  const profile = snapshot({ plan: false });
  const enabled = effectiveWorkflow(profile);
  assert.deepEqual(enabled.workflow, { saved: "enabled", effective: "enabled" });
  assert.deepEqual(enabled.stages.plan, { saved: "disabled", effective: "disabled" });
  assert.deepEqual(enabled.stages.research, { saved: "enabled", effective: "enabled" });

  const optedOut = effectiveWorkflow(profile, { explicitOptOut: true });
  assert.deepEqual(optedOut.workflow, { saved: "enabled", effective: "disabled" });
  assert.deepEqual(optedOut.stages.research, { saved: "enabled", effective: "disabled" });
  assert.deepEqual(effectiveWorkflow(profile), enabled, "one-request opt-out must not change stored choices");

  profile.values.workflow = false;
  const disabled = effectiveWorkflow(profile);
  assert.deepEqual(disabled.workflow, { saved: "disabled", effective: "disabled" });
  assert.ok(Object.values(disabled.stages).every(stage => stage.effective === "disabled"));
  profile.values.workflow = true;
  assert.deepEqual(effectiveWorkflow(profile), enabled, "re-enabling master restores independent stage choices");
});

test("unreadable choices never become enabled authority; an explicitly disabled stage remains disabled", () => {
  const profile = snapshot({ workflow: undefined, plan: false, review: undefined }, {
    workflow: "unreadable workflow",
    review: "unreadable review",
  });
  const unknown = effectiveWorkflow(profile, { explicitOptOut: true });
  assert.deepEqual(unknown.workflow, { saved: "unknown", effective: "unknown" });
  assert.deepEqual(unknown.stages.research, { saved: "enabled", effective: "unknown" });
  assert.deepEqual(unknown.stages.plan, { saved: "disabled", effective: "disabled" });
  assert.deepEqual(unknown.stages.review, { saved: "unknown", effective: "unknown" });

  profile.values.workflow = false;
  delete profile.errors.workflow;
  const disabled = effectiveWorkflow(profile);
  assert.deepEqual(disabled.stages.review, { saved: "unknown", effective: "disabled" });
  profile.values.workflow = true;
  assert.deepEqual(effectiveWorkflow(profile).stages.review, { saved: "unknown", effective: "unknown" });
});
