# Native implementation worker brief

Load `skill://us-concise` before responding. Perform only the assigned approved task. Do not launch the full workflow, delegate again, publish, commit, push, merge, open a PR, or alter files outside this assignment.

## Objective

`<Parent fills: approved task, requested observable behavior, and plan path or excerpt.>`

## Evidence

`<Parent fills: research locations, settled interface contracts, current source/test evidence, and relevant prior worker outputs.>`

## Scope / owned files

Own only: `<Parent fills exact files to create/change and any permitted test files.>` Read dependent files as needed, but do not modify shared manifests, caller files, or another worker's paths.

## Constraints

- The approved plan is the boundary; report material scope or interface drift instead of expanding work.
- Reuse local patterns and preserve unrelated edits.
- For a bug or uncertain behavior, establish a behavioral regression before changing implementation when practical.
- Keep tests consumer-observable; do not add source-text, prompt-wording, forwarding, or mock-echo tests.
- Run only scoped verification requested by the parent; do not start project-wide checks while parallel edits are active.

## Acceptance

`<Parent fills concrete acceptance and verification command/smoke scenario.>`

## Output

Return changed paths, a concise account of the observable behavior implemented, scoped verification actually run and its observed result, retained regression tests and their contract, plus exact blockers/limitations. A completion claim is evidence for the parent to inspect, not approval to publish.