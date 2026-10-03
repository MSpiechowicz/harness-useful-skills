---
name: us-implement
description: Use after an approved plan, a bounded authorized request without an applicable plan stage, or for in-scope repairs. Follow pre-composition triage, native tools, required classified workers, and observable verification.
---

# Implement the authorized change

Load `/useful-skills:us-concise`. Apply the pre-composition lane selection in `/useful-skills:us-workflow` even when loading this skill directly; loading guidance does not launch a full workflow. Read current source/callers, acceptance, available research, and the applicable authorization: approved plan for a selected plan stage, prior in-scope approval for its repairs, or the bounded current request when no plan stage applies (including an eligible focused repair). Enabled `plan` alone does not impose a new approval on focused work. Interrupted work may have drifted. Use available Claude task/plan tools to reflect work, but let current source and observed verification—not task status—determine completion.

## Inputs

Require authorized scope and acceptance, current source/callers, available evidence, the selected lane and any required stages, ownership when delegating, and the changed-surface verification path.

## Scope and authority

Implement only authorized tasks and repairs that satisfy acceptance. Neither plan approval nor a bounded user request permits publication: do not commit, push, merge, open a PR, release, or alter unrelated work unless separately authorized. A material scope or interface change returns to the user and normal composition; use `/useful-skills:us-plan` when its stage applies rather than an undocumented workaround. Prior approval covers in-scope repair without routine new planning or approval.

## Work method

An eligible focused correction may be implemented inline by the parent after source/caller inspection, then observably verified and reported. It does not require worker dispatch, planning, full reviews, or memory solely because switches are enabled. Select extra eligible stages for actual uncertainty, contracts, findings, or security/memory impact; preserve independent requests and disabled/unknown states. An active normal workflow retains its required workers and reviews after repairs; do not reclassify it to omit them.

1. Reuse the repository's established implementation and test patterns. Keep code easy to read: group related declarations with the logic that uses them, separate distinct logical stages and conditional branches with whitespace rather than packing declarations or `if`/`return` statements together, and favor straightforward control flow. Expand complex inline conditionals into clear branches; simple inline cases are fine when clear. For a bug or genuinely uncertain new behavior, establish a behavioral regression that fails before the fix and passes after it. Do not retain tests that merely pin wording, source text, mocks, forwarding, or incidental implementation details.
2. Before dispatching, read **Native model routing** in `/useful-skills:us-workflow` without launching that workflow. Claude Code plugin agents inherit the host model; `Agent` dispatch grants no bypass of permissions, approval, or publication boundaries. Do not assign an unsupported role alias or claim an observed model from a declaration.
3. Classify packages before dispatch: frontend uses `useful-skills:frontend`, backend `useful-skills:backend`, and genuinely neither uses `useful-skills:general-purpose`. Split coherent mixed boundaries and serialize shared files/dependencies. In normal composition use Claude Code’s `Agent` tool for every required package, including one package and in-scope repairs. Eligible focused repair may be inline; optional delegation must be permitted by host policy. The parent owns integration/verification and must not silently substitute for a required worker. Parallelize only ready disjoint packages.
4. Give every implementation worker `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-implement/references/implementation-brief.md`. Assign explicit package ownership, inputs, acceptance, and permitted scoped verification. A worker must not launch the full workflow, delegate again, publish work, or edit outside its assignment.
5. Inspect worker output and changed source before accepting it. A worker's completion claim is evidence to check, not proof.
6. Verify the combined changed surface after all required packages settle. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use findings from required or selected reviews for bounded in-scope repairs. Active normal-workflow repairs retain classified worker dispatch; eligible focused repairs may remain inline. Rerun affected verification, then obtain fresh required or selected `/useful-skills:us-review` and/or `/useful-skills:us-check-security` reviews over affected changes. Do not reuse earlier review evidence for newly changed code, restart unrelated stages, or require routine re-approval within scope.

## Completion evidence

Report actual files/interfaces changed, lane and reason, ownership/classification if delegated, selected Claude agent and observed worker/model metadata only when available, observed changed-surface verification, retained regressions, and limitations. Hand evidence to required or selected reviews. Omitted/disabled stages are skipped, never completed; inline focused repair needs no invented worker metadata or plan.

## Failure behavior

Respect stronger host policies. If a required selected Claude agent is absent, prohibited, or unavailable, complete independently reachable work and report the exact limitation. Do not invent agents/models, alter configuration, or silently replace a required worker; authorized focused inline repair remains permitted. Diagnose failed verification within the active lane, retaining required workers and fresh reviews; a plausible diff is not completion.