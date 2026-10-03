---
name: us-review
description: Use after authorized changes when correctness review applies in normal workflow, is selected for an eligible focused repair, or is explicitly requested. Obtain a fresh evidence-based review against authorized acceptance.
---

# Fresh correctness review

Load `/useful-skills:us-concise`. Apply lane selection in `/useful-skills:us-workflow`, including on direct loading; enabled `review` alone does not force a focused repair into a full cycle. Review current source and observed verification against authorized acceptance (applicable approved plan, prior in-scope approval, or bounded request), not implementer confidence. This skill is read-only and does not edit, publish, approve, or replace security review. Disabled/unknown automatic review is not selected automatically; independent review requests remain binding. A selected focused review must be fresh after affected changes, just like a required normal-workflow review.

## Inputs

Require authorized scope and acceptance, implementation evidence, changed files/interfaces, relevant test or smoke results, and current source. Inspect the current revision rather than trusting a previous review or a worker's summary.

## Request an independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `/useful-skills:us-workflow`; loading that guidance does not launch the workflow.

Dispatch `useful-skills:reviewer` through Claude Code’s `Agent` tool. Only if unavailable and host policy permits, use `useful-skills:general-purpose` with a read-only correctness brief and report the fallback. Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-review/references/reviewer-brief.md` and provide the filled brief to the worker. The reviewer must be fresh after implementation and inspect actual callers, edge conditions, errors, and verification against acceptance.

Sort findings by material impact. Each finding includes severity, confidence, exact file and line/symbol, evidence or a safe reproduction, consumer impact, and concrete repair direction. Distinguish confirmed acceptance failures from risks, missing evidence, and minor suggestions. “No findings” means no issue was found in the reviewed scope, not that the code is universally correct.

## Repair loop

Send verified acceptance failures and material issues to `/useful-skills:us-implement` for authorized in-scope repair, retaining the active lane and its required workers. Rerun affected verification and obtain fresh required or selected correctness/security reviews after affected changes; never reuse earlier review evidence for newly changed code or restart unrelated stages. Prior approval covers in-scope repair without routine new planning/approval. After three unsuccessful repair rounds or repeated no-progress findings, preserve work and explain the blocker rather than weakening acceptance.

## Completion evidence

Return scope, reviewer capability, source revision/paths, evidence, findings/disposition, and residual limitations. Load `/useful-skills:us-check-security` only when applicable and enabled in normal composition, selected and eligible for focused work, or independently requested. Correctness review does not satisfy required security review; omitted stages are skipped, not completed.

## Failure behavior

If no fresh native worker is available, report that the enabled independent-review requirement could not be met. Do not present author self-review as independent evidence, add a custom agent catalog, or modify production code from this skill.