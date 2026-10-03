---
name: us-implement
description: Use after an approved plan, a bounded authorized request without an applicable plan stage, or for in-scope repairs. Follow pre-composition triage, native tools, required classified workers, and observable verification.
---

# Implement the authorized change

Load `skill://us-concise`. Apply the pre-composition lane selection in `skill://us-workflow` even when loading this skill directly; loading guidance does not launch a full workflow. Read current source/callers, acceptance, available research, and the applicable authorization: approved plan for a selected plan stage, prior in-scope approval for its repairs, or the bounded current request when no plan stage applies (including an eligible focused repair). Enabled `plan` alone does not impose a new approval on focused work. Interrupted work may have drifted. Use native `todo` to reflect work, but let current source and observed verification—not task status—determine completion.

## Inputs

Require authorized scope and acceptance, current source/callers, available evidence, the selected lane and any required stages, ownership when delegating, and the changed-surface verification path.

## Scope and authority

Implement only authorized tasks and repairs that satisfy acceptance. Neither plan approval nor a bounded user request permits publication: do not commit, push, merge, open a PR, release, or alter unrelated work unless separately authorized. A material scope or interface change returns to the user and normal composition; use `skill://us-plan` when its stage applies rather than an undocumented workaround. Prior approval covers in-scope repair without routine new planning or approval.

## Work method

An eligible focused correction may be implemented inline by the parent after source/caller inspection, then observably verified and reported. It does not require worker dispatch, planning, full reviews, or memory solely because switches are enabled. Select extra eligible stages for actual uncertainty, contracts, findings, or security/memory impact; preserve independent requests and disabled/unknown states. An active normal workflow retains its required workers and reviews after repairs; do not reclassify it to omit them.

1. Reuse the repository's established implementation and test patterns. Keep code easy to read: group related declarations with the logic that uses them, separate distinct logical stages and conditional branches with whitespace rather than packing declarations or `if`/`return` statements together, and favor straightforward control flow. Expand complex inline conditionals into clear branches; simple inline cases are fine when clear. For a bug or genuinely uncertain new behavior, establish a behavioral regression that fails before the fix and passes after it. Do not retain tests that merely pin wording, source text, mocks, forwarding, or incidental implementation details.
2. Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `skill://us-workflow`; loading that guidance does not launch the workflow. Ordinary installed startup supplies the narrowly scoped session-local policy for a selected native implementation worker once implementation is authorized, including a single work package. It grants no general extra-delegation permission and does not override stronger safety constraints, existing mappings, permissions, approval, or publication boundaries. Inspect existing routing only when needed; no host override, prompt file, or startup flag is required. `frontend` prioritizes `@frontend` then `@implementation`; `backend` prioritizes `@backend` then `@implementation`; generic `task` uses `@implementation`. `task.agentModelOverrides[agentName]` always wins. Configuration is not automatic model switching and does not prove the spawned worker's model; report actual worker/model metadata separately when available.
3. Classify every authorized package before dispatch: frontend packages use `frontend`, backend packages use `backend`, and only genuinely neither packages—such as documentation or tooling—use native `task`. Split mixed packages where coherent; otherwise explain the boundary and serialize dependencies. In normal composition, dispatch the selected native worker for every required package, including one package and bounded in-scope repairs. Focused inline implementation is permitted; any optional delegation must still be permitted by host policy and use the correct classification. The parent coordinates required dispatch, inspection, integration, and verification and must not silently replace a required worker. Parallelize only ready independent packages with disjoint owned files and settled interfaces; serialize shared files/manifests, interfaces, and callers.
4. Give every implementation worker `skill://us-implement/references/implementation-brief.md`. Assign explicit package ownership, inputs, acceptance, and permitted scoped verification. A worker must not launch the full workflow, delegate again, publish work, or edit outside its assignment.
5. Inspect worker output and changed source before accepting it. A worker's completion claim is evidence to check, not proof.
6. Verify the combined changed surface after all required packages settle. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use findings from required or selected reviews for bounded in-scope repairs. Active normal-workflow repairs retain classified worker dispatch; eligible focused repairs may remain inline. Rerun affected verification, then obtain fresh required or selected `skill://us-review` and/or `skill://us-check-security` reviews over affected changes. Do not reuse earlier review evidence for newly changed code, restart unrelated stages, or require routine re-approval within scope.

## Completion evidence

Report actual files/interfaces changed, selected lane and reason, ownership and classification if delegated, configured worker routing and observed worker/model metadata only when available, observed changed-surface verification, retained behavioral regressions, and limitations. Hand evidence to required or selected reviews; state omitted/disabled stages as skipped, not completed. Inline focused repair needs no invented worker metadata or plan.

## Failure behavior

Respect stronger host policies. If a required selected native worker is absent, prohibited, or has no allowed route, complete only independently reachable work and report the exact limitation; do not invent an agent/model, change configuration, or silently substitute parent work for a required worker. This does not prohibit authorized focused inline repair. If verification fails, diagnose within scope and the active lane, retaining required workers and fresh reviews; a plausible diff is not completion.