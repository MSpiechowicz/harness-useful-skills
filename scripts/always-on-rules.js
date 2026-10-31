// Host-neutral rewrites shared by the always-on renderers (Codex, Pi). Each rule removes the saved-settings and "enabled" wording
// of the canonical OMP skills. Host-specific wording stays in the renderer that needs it. Importing has no side effects.
import { replace, line, every } from './skill-render-core.js';

export const ALWAYS_ON = {
  'us-approve-work'(text) {
    text = replace(text, 'verification/enabled-review outcomes', 'verification/review outcomes');
    text = replace(text, 'verification, enabled reviews, or isolation', 'verification, reviews, or isolation');
    return text;
  },
  'us-ship-backlog-item'(text) {
    text = replace(text, 'when the profile workflow is enabled', 'unless the user opted out as described below');
    text = replace(text, 'with native file tools', 'with file tools');
    text = replace(text, 'the enabled stages, and a linked PR', 'the workflow stages, and a linked PR');
    text = replace(text, 'satisfies enabled reviews and', 'satisfies the reviews and');
    text = replace(text, 'With `plan` enabled, still obtain canonical implementation plan approval before edits; when disabled, a bounded shipment request', 'Still obtain canonical implementation plan approval before edits; if the user opted out with `us-ignore-workflow`, a bounded shipment request');
    text = replace(text, 'plan according to enabled stages', 'plan according to the workflow stages');
    text = replace(text, 'It owns enabled clarification', 'It owns clarification');
    text = replace(text, 'through enabled `us-run-workflow` stages; request only enabled correctness and security reviews and the enabled release assessment', 'through the `us-run-workflow` stages; request only the correctness and security reviews and the release assessment');
    text = replace(text, 'all enabled workflow stages complete', 'all workflow stages complete');
    text = replace(text, 'verification and enabled-review outcomes', 'verification and review outcomes');
    text = replace(text, 'verification/enabled-review evidence', 'verification/review evidence');
    text = replace(text, 'through the enabled `us-run-workflow` stages (or the fast lane when workflow is disabled), verification, fresh enabled correctness/security reviews, and a fresh enabled release assessment', 'through the `us-run-workflow` stages (or the fast lane if the user opted out), verification, fresh correctness/security reviews, and a fresh release assessment');
    return text;
  },
  'us-improve-codebase-architecture'(text) {
    text = replace(text, 'to native `us-*` stages', 'to the `us-*` stages');
    text = replace(text, 'use enabled owned stages directly', 'use the owned stages directly');
    text = replace(text, 'When automatic `research` is enabled, load `skill://us-research`; enabled backend/graph memory actions', 'Load `skill://us-research`; backend/graph memory actions');
    text = line(text, '3. When automatic `plan` is enabled', '3. Load `skill://us-plan` to produce one actionable plan and obtain explicit approval before edits; preserve any independent approval requirement.');
    text = line(text, '5. Obtain fresh correctness review', '5. Obtain fresh correctness review through `skill://us-review` and security review through `skill://us-check-security`. After verified work and the reviews, use `skill://us-manage-memory` for the backend/graph actions.');
    text = replace(text, '(and to planning when enabled)', '(and to planning)');
    return text;
  },
  'us-improve-code-coverage'(text) {
    text = replace(text, 'through `skill://us-research` when `research` is enabled; otherwise do essential source inspection without mandatory scout, using `skill://us-manage-memory` for independently enabled backend/graph actions. When `plan` is enabled, use `skill://us-plan` to present proposed test scope and request explicit approval before lasting test edits. When disabled, a bounded user request can authorize tests without a mandatory planner or separate plan approval; independent authorization requirements remain.', 'through `skill://us-research`, using `skill://us-manage-memory` for the backend/graph memory actions independently. Use `skill://us-plan` to present proposed test scope and request explicit approval before lasting test edits; independent authorization requirements remain.');
    text = every(text, '(through `skill://us-plan` when enabled)', '(through `skill://us-plan`)');
    text = replace(text, 'through `skill://us-review` when `review` is enabled and security review through `skill://us-check-security` when `security-review` is enabled.', 'through `skill://us-review` and security review through `skill://us-check-security`.');
    text = replace(text, 'obtain fresh enabled reviews after each repair. After verified work and enabled reviews, use `skill://us-manage-memory` only for enabled backend/graph actions.', 'obtain fresh reviews after each repair. After verified work and reviews, use `skill://us-manage-memory` for the backend/graph actions.');
    text = replace(text, 'actual outcomes of enabled `skill://us-review`, `skill://us-check-security`, and `skill://us-manage-memory` actions, marking disabled stages as skipped', 'actual outcomes of the review (`skill://us-review`), security review (`skill://us-check-security`), and memory (`skill://us-manage-memory`) stages, marking unselected stages as skipped');
    return text;
  },
  'us-use-harness-memory'(text) {
    text = replace(text, 'for an enabled backend-memory stage', 'for the backend-memory stage');
    return text;
  },
  'us-ignore-workflow'(text) {
    text = replace(text, ' without changing saved settings', '');
    text = replace(text, ' regardless of individual stage values', '');
    return text;
  },
  'us-run-workflow'(text) {
    text = replace(text, 'Picks a focused or full lane, then applies the enabled stages', 'Picks a focused or full lane, then applies the stages');
    text = replace(text, 'when us-ignore-workflow was directly invoked', 'when the user directly asked for us-ignore-workflow');
    text = line(text, 'For enabled workflow, the persisted', 'Unless the request opted out, every stage below is eligible for automatic use. Before composing stages, select the lane below. Eligibility is not evidence of execution or a requirement to run every stage in a focused repair. Explicit user audits, full-workflow requests, and memory/graph operations remain independent obligations or actions.');
    text = replace(text, 'Enabled switches alone do not require', 'Stage availability alone does not require');
    text = replace(text, ' Never silently enable a disabled/unknown automatic stage; explicit requirements remain independent.', ' Explicit requirements remain independent.');
    text = line(text, '2. If `research` is enabled', '2. Load `skill://us-research` for bounded reconnaissance. During that inspection, use `skill://us-manage-memory` for the `backend-memory` and `code-graph` actions independently.');
    text = line(text, '5. Verify the combined', '5. Verify the combined changed surface. Load `skill://us-review` for a fresh correctness review, then `skill://us-check-security` for a fresh security review.');
    text = replace(text, 'repeat required enabled reviews fresh', 'repeat required reviews fresh');
    text = line(text, '7. If `release-assessment` is enabled', '7. Load `skill://us-assess-release` for a fresh assessment of the exact final head. Re-run it after any later change.');
    text = line(text, '8. Prepare a concise summary', '8. Prepare a concise summary of verified work, including the review tier, release confidence, and reasons. Load `skill://us-manage-memory` for the automatic `backend-memory` and `code-graph` actions and report observed outcomes.');
    text = replace(text, ', and never silently activate a disabled or unknown stage.', '.');
    text = replace(text, 'required enabled stages', 'required stages');
    text = replace(text, 'Do not force a disabled stage, invoke legacy commands', 'Do not invoke legacy commands');
    text = replace(text, 'unmet requirements of enabled independent reviews', 'unmet requirements of independent reviews');
    return text;
  },
  'us-manage-memory'(text) {
    text = line(text, 'Apply pre-composition lane selection', 'Apply pre-composition lane selection in `skill://us-run-workflow`, including on direct loading. The memory stages alone do not require calls for an eligible focused repair. Select each eligible automatic action only for concrete memory/relationship impact; normal composition still uses its applicable memory stages. Explicit memory/graph requests remain independent. This skill never forces new research, planning, delegation, or reviews.');
    text = replace(text, 'in an enabled memory action before', 'in a memory action before');
    text = replace(text, 'with the actual enabled failed action', 'with the actual failed action');
    text = replace(text, 'Do not claim an enabled required memory action completed while unsuccessful; a disabled action is skipped, not failed or complete.', 'Do not claim a required memory action completed while unsuccessful; an unselected action is skipped, not failed or complete.');
    text = line(text, 'Report applicable automatic or explicitly requested actions attempted', 'Report applicable automatic or explicitly requested actions attempted, observed backend and project-scoped paths, bounded search evidence, code graph lookups, saved fact if any, and limitations. Unselected focused actions are skipped, never completed; do not claim redaction guarantees safe storage.');
    return text;
  },
  'us-plan'(text) {
    text = replace(text, 'An enabled plan switch alone', 'The plan stage alone');
    text = replace(text, 'just because `plan` is enabled', 'just because the plan stage exists');
    text = replace(text, 'into a `skill://us-grill-me` round', 'into a round with `skill://us-grill-me`');
    return text;
  },
  'us-implement'(text) {
    text = replace(text, 'Enabled `plan` alone does not impose', 'The plan stage alone does not impose');
    text = replace(text, 'solely because switches are enabled', 'solely because those stages exist');
    text = replace(text, '; preserve independent requests and disabled/unknown states', '; preserve independent requests');
    text = replace(text, 'state omitted/disabled stages as skipped', 'state omitted stages as skipped');
    return text;
  },
  'us-research'(text) {
    text = line(text, 'Load `skill://us-write-concisely`. Apply lane selection', 'Load `skill://us-write-concisely`. Apply lane selection in `skill://us-run-workflow` before composing automatic stages, including on direct loading. Research is read-only reconnaissance, not code, a plan, or approval. An eligible focused repair still requires current source/caller inspection but no automatic scout or full research cycle merely because the research stage exists. Select this stage for concrete uncertainty or an independent request; essential inspection remains the parent\'s duty.');
    text = replace(text, 'Enabled memory settings alone', 'The memory stages alone');
    return text;
  },
  'us-review'(text) {
    text = replace(text, ' Disabled/unknown automatic review is not selected automatically; independent review requests remain binding.', ' Independent review requests remain binding.');
    text = replace(text, 'require the `skill://us-keep-ui-consistent` instance table', 'require the instance table from `skill://us-keep-ui-consistent`');
    text = replace(text, 'enabled `review` alone does not force', 'the review stage alone does not force');
    text = replace(text, 'when applicable and enabled in normal composition', 'when applicable in normal composition');
    text = replace(text, 'that the enabled independent-review requirement', 'that the independent-review requirement');
    text = replace(text, 'If no fresh native worker is available', 'If no fresh independent worker is available');
    return text;
  },
  'us-assess-release'(text) {
    text = replace(text, ' Disabled/unknown automatic assessment is not selected automatically. Explicit assessment requests remain binding.', ' Explicit assessment requests remain binding.');
    return text;
  },
  'us-check-security'(text) {
    text = replace(text, 'Disabling automatic `security-review` suppresses only that workflow stage', 'An ignore-workflow opt-out suppresses only the automatic workflow stage');
    text = replace(text, 'Enabled `security-review` alone does not', 'The `security-review` stage alone does not');
    text = replace(text, ' Disabled/unknown stages are not activated automatically.', '');
    return text;
  },
  'us-implement/references/implementation-brief.md'(text) {
    text = replace(text, '# Native implementation work-package brief', '# Implementation work-package brief');
    return text;
  },
  'us-review/references/reviewer-brief.md'(text) {
    text = replace(text, 'when applicable and enabled in normal composition', 'when applicable in normal composition');
    text = replace(text, 'do not claim a disabled stage completed', 'do not claim an omitted stage completed');
    return text;
  },
};
