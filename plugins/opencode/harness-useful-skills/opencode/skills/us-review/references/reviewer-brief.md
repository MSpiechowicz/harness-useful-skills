# Fresh correctness reviewer brief

Load `us-write-concisely` with the `skill` tool before responding. Review only; do not edit, run a workflow, publish, or ask another worker to fix findings.

## Objective

`<Parent fills: authorized acceptance criteria and exact review question; approved plan if applicable, otherwise bounded user-request scope.>`

## Evidence

`<Parent fills: available plan path/excerpt, implementation report, changed paths/interfaces, and verification output.>` Treat implementation claims as untrusted until current source supports them.

## Scope / owned files

Read only: `<Parent fills changed files plus required callers, tests, and configuration.>` No file ownership or modifications are granted.

## Constraints

- Inspect the resulting source and actual consumer paths against authorized acceptance, not generic preferences.
- Check behavioral boundaries, error paths, transitions, precedence, and whether verification proves the contract.
- For a change to how a UI element looks or behaves, verify sibling coverage read-only, using the search and classification steps of the `us-keep-ui-consistent` skill without editing. A missing instance table is missing evidence. An unchanged same-pattern sibling in the same app or package without cited variant evidence is an acceptance failure; one the skill correctly sent to the user for a decision is not.
- Separate acceptance failures from risks, missing evidence, and minor suggestions.
- Do not claim security review; the parent invokes the `us-check-security` skill separately when applicable and enabled in normal composition, selected and eligible for focused work, or independently required. This brief does not restart unselected stages.

## Acceptance

Return a fresh, evidence-backed correctness assessment with enough detail for an in-scope repair or an honest residual-risk decision; do not claim a disabled stage completed.

## Output

For every finding: severity, confidence, exact path and line/symbol, evidence or safe reproduction, consumer impact, and concrete repair direction. Also report files/paths inspected, verification evidence reviewed, confirmed no-finding areas, limitations, and whether authorized acceptance is met in the reviewed scope.