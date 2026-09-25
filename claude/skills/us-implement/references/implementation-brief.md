# Native implementation work-package brief

Load `/useful-skills:us-concise` before responding. This brief assigns one authorized classified package: `useful-skills:frontend` for frontend, `useful-skills:backend` for backend, or `useful-skills:general-purpose` for genuinely neither. Authorization is the approved plan when `plan` is enabled, otherwise the bounded user request; independent approval still applies. All plugin agents inherit the host model and permissions. The parent selects package and agent; the worker must not claim an observed model without runtime evidence. Do not launch another workflow, delegate, publish, commit, push, merge, open a PR, or expand the assignment.

## Objective

`<Parent fills: authorized task, requested observable behavior, and approved plan path/excerpt when applicable or bounded user-request scope when plan is disabled.>`

## Evidence

`<Parent fills: research locations, settled interface contracts, current source/test evidence, and relevant prior worker outputs.>`

## Scope / owned files

Own only: `<Parent fills package classification, selected worker, exact files to create/change, and any permitted test files.>` Read dependent files as needed, but do not modify shared manifests, caller files, or another worker's paths.
- Work only in the active session workspace; do not select a repository globally.

## Constraints

- The authorized scope is the boundary; report material scope or interface drift instead of expanding work.
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