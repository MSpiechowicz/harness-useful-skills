---
name: us-review
description: Use after code changes or when asked: "review my changes", "check this diff", "look over this code", "is this correct", or when the review stage applies in the workflow. Fresh, evidence-based correctness review of changed code against acceptance, callers, edge cases, errors, and verification.
---

# Fresh correctness review

Load `/harness-useful-skills:us-write-concisely`. Apply lane selection in `/harness-useful-skills:us-run-workflow` when loaded directly; as a stage of an active workflow, keep that workflow's lane and never switch it to omit stages; enabled `review` alone does not force a focused repair into a full cycle. Review current source and observed verification against authorized acceptance (applicable approved plan, prior in-scope approval, or bounded request), not implementer confidence. This skill is read-only and does not edit, publish, approve, or replace security review. Disabled/unknown automatic review is not selected automatically; independent review requests remain binding. A selected focused review must be fresh after affected changes, just like a required normal-workflow review.

## Inputs

Require authorized scope and acceptance, implementation evidence, changed files/interfaces, relevant test or smoke results, and current source. Inspect the current revision rather than trusting a previous review or a worker's summary. For a change to how a UI element looks or behaves, also require the `/harness-useful-skills:us-keep-ui-consistent` instance table; if it is missing, report missing evidence and run its search and classification steps yourself, read-only.

## Request an independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `/harness-useful-skills:us-run-workflow`; loading that guidance does not launch the workflow.

Dispatch `harness-useful-skills:reviewer` through Claude Code’s `Agent` tool. Only if unavailable and host policy permits, use `harness-useful-skills:general-purpose` with a read-only correctness brief and report the fallback. Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-review/references/reviewer-brief.md` and provide the filled brief to the worker. The reviewer must be fresh after implementation and inspect actual callers, edge conditions, errors, and verification against acceptance.

Sort findings by material impact. Each finding includes severity, confidence, exact file and line/symbol, evidence or a safe reproduction, consumer impact, and concrete repair direction. Distinguish confirmed acceptance failures from risks, missing evidence, and minor suggestions. “No findings” means no issue was found in the reviewed scope, not that the code is universally correct.

For such changes, check sibling coverage using the skill's search and classification steps: an unchanged same-pattern sibling in the same app or package without cited variant evidence is an acceptance failure; one the skill correctly sent to the user for a decision is not.

## Repair loop

Send verified acceptance failures and material issues to `/harness-useful-skills:us-implement` for authorized in-scope repair, retaining the active lane and its required workers. Rerun affected verification and obtain fresh required or selected correctness/security reviews after affected changes; never reuse earlier review evidence for newly changed code or restart unrelated stages. Prior approval covers in-scope repair without routine new planning/approval. Fix a simple finding (local, low-risk, obvious repair such as a typo, missing guard, wrong message, or small test gap) inline without a new worker, and scope its re-review to the repaired lines and the findings they answer, not the whole change. Report minor suggestions instead of looping on them. Cap each review stage at three passes—the first review plus at most two re-reviews—counted whether or not a pass finds something new. A High finding is never accepted: while any pass reports one, keep going past the cap—repair it, then run a fresh full-scope review of the whole change (not one scoped to the repaired lines)—until no High finding remains. Once the cap is reached and no High finding is open, start no further repair or review round, even for Medium or lower findings: preserve the work, report every unresolved finding with its severity, and let the user decide which to fix; never weaken acceptance or claim it met.

## Completion evidence

Return scope, reviewer capability, source revision/paths, evidence, findings/disposition, and residual limitations. Load `/harness-useful-skills:us-check-security` only when applicable and enabled in normal composition, selected and eligible for focused work, or independently requested. Correctness review does not satisfy required security review; omitted stages are skipped, not completed. As a workflow stage, return to `/harness-useful-skills:us-run-workflow` and continue its remaining stages (security review, repairs, memory, summary); this review does not complete the workflow.

## Failure behavior

If no fresh native worker is available, report that the enabled independent-review requirement could not be met. Do not present author self-review as independent evidence, add a custom agent catalog, or modify production code from this skill.