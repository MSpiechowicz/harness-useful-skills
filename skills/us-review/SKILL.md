---
name: us-review
description: Use automatically after implementing or repairing an approved software change to obtain a fresh, evidence-based correctness review against the approved acceptance criteria.
---

# Fresh correctness review

Load `skill://us-concise`. Review the resulting source and observed verification against the approved plan and acceptance, not the implementer's confidence. This skill is read-only: it reports findings and does not edit, publish, approve, or replace security review.

## Inputs

Require the approved plan and acceptance, implementation evidence, changed files/interfaces, relevant test or smoke results, and current source. Inspect the current revision rather than trusting a previous review or a worker's summary.

## Request an independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `skill://us-workflow`; loading that guidance does not launch the workflow.

Use native `reviewer` only if advertised; otherwise dispatch the advertised general-purpose worker with a correctness-review role. Give it `skill://us-review/references/reviewer-brief.md`. The reviewer must be fresh with respect to the implementation and inspect current source, actual callers, edge conditions, errors, and whether verification proves the stated acceptance.

Sort findings by material impact. Each finding includes severity, confidence, exact file and line/symbol, evidence or a safe reproduction, consumer impact, and concrete repair direction. Distinguish confirmed acceptance failures from risks, missing evidence, and minor suggestions. “No findings” means no issue was found in the reviewed scope, not that the code is universally correct.

## Repair loop

Send verified acceptance failures and material issues to `skill://us-implement` for in-scope repair. Re-run affected verification, then obtain a new correctness review and a new `skill://us-check-security` review. Do not reuse a prior review after code changes. After three unsuccessful repair rounds or repeated no-progress findings, preserve the work and explain the blocker instead of weakening acceptance or looping indefinitely.

## Completion evidence

Return review scope, reviewer capability used, source revision/paths inspected, evidence considered, findings with disposition, and explicit residual limitations. After correctness review, load `skill://us-check-security`; correctness review alone does not complete the workflow.

## Failure behavior

If no fresh native worker is available, report that the independent-review requirement could not be met. Do not present author self-review as independent evidence, add a custom agent catalog, or modify production code from this skill.