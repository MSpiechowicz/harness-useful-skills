# Native implementation work-package brief

Load `skill://us-concise` before responding. This brief assigns one authorized classified package: frontend uses `frontend` (`@frontend`, then `@implementation`), backend uses `backend` (`@backend`, then `@implementation`), and genuinely neither uses `task` (normally `@implementation`). Authorization is the applicable approved plan, prior approval for in-scope repairs, or the bounded current request when no plan stage applies, including eligible focused work; enabled `plan` alone does not require a new plan/approval for focused repair. Independent approval requirements remain. `task.agentModelOverrides[agentName]` always wins; declarations do not prove the running model. The parent selects lane, classification, and worker; do not choose or claim a model. Perform only the assigned task. Do not launch a full workflow, delegate, publish, commit, push, merge, open a PR, or alter files outside the assignment.

## Objective

`<Parent fills: authorized task, observable acceptance, selected lane/required stages, and applicable plan excerpt, prior in-scope approval, or bounded current request.>`

## Evidence

`<Parent fills: research locations, settled interface contracts, current source/test evidence, and relevant prior worker outputs.>`

## Scope / owned files

Own only: `<Parent fills package classification, selected worker, exact files to create/change, and any permitted test files.>` Read dependent files as needed, but do not modify shared manifests, caller files, or another worker's paths.
- Work only in the active session workspace; do not select a repository globally.

## Constraints

- The authorized scope is the boundary; report material scope or interface drift instead of expanding work.
- Respect the parent's lane and selected stages. Optional focused delegation does not restart planning/full reviews/memory. Active normal-workflow repairs retain required fresh reviews, owned by the parent, without routine new planning/approval.
- Reuse local patterns and preserve unrelated edits.
- Keep code easy to read: group related declarations with the logic that uses them, separate distinct logical stages and conditional branches with whitespace rather than packing declarations or `if`/`return` statements together, and favor straightforward control flow. Expand complex inline conditionals into clear branches; simple inline cases are fine when clear.
- For a bug or uncertain behavior, establish a behavioral regression before changing implementation when practical.
- Keep tests consumer-observable; do not add source-text, prompt-wording, forwarding, or mock-echo tests.
- Run only scoped verification requested by the parent; do not start project-wide checks while parallel edits are active.
- Return a limitation rather than inventing a role, model, worker, fallback, reclassification, or additional delegation when stronger host policy prevents the assigned work.

## Acceptance

`<Parent fills concrete acceptance and verification command/smoke scenario.>`

## Output

Return changed paths, a concise account of the observable behavior implemented, scoped verification actually run and its observed result, retained regression tests and their contract, plus exact blockers/limitations. Include the assigned package classification and any actual worker/model metadata supplied at runtime. A completion claim is evidence for the parent to inspect, not approval to publish or proof of the routed model.