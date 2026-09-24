# Native implementation work-package brief

Load `skill://us-concise` before responding. This brief assigns exactly one approved, classified work package to its selected native worker: frontend uses `frontend` (`@frontend`, then `@implementation`), backend uses `backend` (`@backend`, then `@implementation`), and genuinely neither uses `task` (normally `@implementation`). `task.agentModelOverrides[agentName]` always wins; agent frontmatter and configured roles do not prove the observed running model. The parent selects the classification and worker; the worker must not select or claim a model. Perform only the assigned task. Do not launch the full workflow, delegate again, publish, commit, push, merge, open a PR, or alter files outside this assignment.

## Objective

`<Parent fills: approved task, requested observable behavior, and plan path or excerpt.>`

## Evidence

`<Parent fills: research locations, settled interface contracts, current source/test evidence, and relevant prior worker outputs.>`

## Scope / owned files

Own only: `<Parent fills package classification, selected worker, exact files to create/change, and any permitted test files.>` Read dependent files as needed, but do not modify shared manifests, caller files, or another worker's paths.
- Work only in the active session workspace; do not select a repository globally.

## Constraints

- The approved plan is the boundary; report material scope or interface drift instead of expanding work.
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