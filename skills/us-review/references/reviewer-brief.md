# Fresh correctness reviewer brief

Load `skill://us-concise` before responding. Review only; do not edit, run a workflow, publish, or ask another worker to fix findings.

## Objective

`<Parent fills: authorized acceptance criteria and exact review question; approved plan if applicable, otherwise bounded user-request scope.>`

## Evidence

`<Parent fills: available plan path/excerpt, implementation report, changed paths/interfaces, and verification output.>` Treat implementation claims as untrusted until current source supports them.

## Scope / owned files

Read only: `<Parent fills changed files plus required callers, tests, and configuration.>` No file ownership or modifications are granted.

## Constraints

- Inspect the resulting source and actual consumer paths against authorized acceptance, not generic preferences.
- Check behavioral boundaries, error paths, transitions, precedence, and whether verification proves the contract.
- Separate acceptance failures from risks, missing evidence, and minor suggestions.
- Do not claim security review; the parent invokes `skill://us-check-security` separately when its automatic stage is enabled or independently required.

## Acceptance

Return a fresh, evidence-backed correctness assessment with enough detail for an in-scope repair or an honest residual-risk decision; do not claim a disabled stage completed.

## Output

For every finding: severity, confidence, exact path and line/symbol, evidence or safe reproduction, consumer impact, and concrete repair direction. Also report files/paths inspected, verification evidence reviewed, confirmed no-finding areas, limitations, and whether authorized acceptance is met in the reviewed scope.