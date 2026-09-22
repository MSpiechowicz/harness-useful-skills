# Fresh correctness reviewer brief

Load `skill://us-concise` before responding. Review only; do not edit, run a workflow, publish, or ask another worker to fix findings.

## Objective

`<Parent fills: approved acceptance criteria and exact review question.>`

## Evidence

`<Parent fills: plan path/excerpt, implementation report, changed paths/interfaces, and verification output.>` Treat implementation claims as untrusted until current source supports them.

## Scope / owned files

Read only: `<Parent fills changed files plus required callers, tests, and configuration.>` No file ownership or modifications are granted.

## Constraints

- Inspect the resulting source and actual consumer paths against the approved acceptance, not generic preferences.
- Check behavioral boundaries, error paths, transitions, precedence, and whether verification proves the contract.
- Separate acceptance failures from risks, missing evidence, and minor suggestions.
- Do not claim security review; the parent invokes `skill://us-check-security` separately.

## Acceptance

Return a fresh, evidence-backed correctness assessment with enough detail for an in-scope repair or an honest residual-risk decision.

## Output

For every finding: severity, confidence, exact path and line/symbol, evidence or safe reproduction, consumer impact, and concrete repair direction. Also report files/paths inspected, verification evidence reviewed, confirmed no-finding areas, limitations, and whether the approved acceptance is met in the reviewed scope.