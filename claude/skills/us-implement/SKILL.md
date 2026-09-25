---
name: us-implement
description: Use after software implementation is authorized by an approved plan or, with the automatic plan stage disabled, a bounded user request; also repair findings within authorized scope. Implement through native tools, classified workers, and observable verification.
---

# Implement the authorized change

Load `/useful-skills:us-concise`. Read the approved plan when `plan` is enabled; otherwise read the bounded user request, current source, and any available research evidence. Interrupted work may have drifted. Use available Claude task/plan tools to reflect work, but let current source and observed verification—not task status—determine completion.

## Inputs

Require authorization (approved plan when `plan` is enabled, bounded user request when disabled), acceptance, current source, available research evidence, declared worker ownership, and the changed-surface verification path.

## Scope and authority

Implement only authorized tasks and repairs that satisfy acceptance. Neither plan approval nor a bounded user request permits publication: do not commit, push, merge, open a PR, release, or alter unrelated work unless separately authorized. A material scope or interface change returns to the user; if `plan` is enabled, use `/useful-skills:us-plan` to propose it rather than an undocumented workaround.

## Work method

1. Reuse the repository's established implementation and test patterns. Keep code easy to read: group related declarations with the logic that uses them, separate distinct logical stages and conditional branches with whitespace rather than packing declarations or `if`/`return` statements together, and favor straightforward control flow. Expand complex inline conditionals into clear branches; simple inline cases are fine when clear. For a bug or genuinely uncertain new behavior, establish a behavioral regression that fails before the fix and passes after it. Do not retain tests that merely pin wording, source text, mocks, forwarding, or incidental implementation details.
2. Before dispatching, read **Native model routing** in `/useful-skills:us-workflow` without launching that workflow. Claude Code plugin agents inherit the host model; `Agent` dispatch grants no bypass of permissions, approval, or publication boundaries. Do not assign an unsupported role alias or claim an observed model from a declaration.
3. Classify every authorized package before dispatch: frontend uses `useful-skills:frontend`, backend uses `useful-skills:backend`, and genuinely neither (documentation/tooling) uses `useful-skills:general-purpose`. Split mixed packages where coherent and serialize overlapping files or dependencies. Dispatch through Claude Code’s `Agent` tool for each required package, including one package and in-scope repairs. The parent owns integration and verification, never silently substitutes itself for an enabled required worker. Parallelize only ready disjoint packages.
4. Give every implementation worker `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-implement/references/implementation-brief.md`. Assign explicit package ownership, inputs, acceptance, and permitted scoped verification. A worker must not launch the full workflow, delegate again, publish work, or edit outside its assignment.
5. Inspect worker output and changed source before accepting it. A worker's completion claim is evidence to check, not proof.
6. Verify the combined changed surface after all required packages settle. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use findings from enabled reviews to define bounded in-scope repair packages, classify them, and dispatch them through the selected Claude plugin agent. After repair, rerun affected verification and return only to enabled `/useful-skills:us-review` and/or `/useful-skills:us-check-security` stages; each enabled review must be fresh after a repair.

## Completion evidence

Report actual files and interfaces changed, package classification and ownership, selected Claude agent and observed worker/model metadata only when available, commands or observed changed-surface behavior, retained behavioral regressions, and limitations. Hand this evidence to each enabled review; do not claim a disabled review completed.

## Failure behavior

Respect stronger host policies. If the selected Claude plugin agent is absent, prohibited, or cannot be launched, complete only other independently dispatchable packages and report that exact limitation. Do not invent an agent or model, change host configuration, silently substitute parent implementation, or count a fallback as successful specialist routing. If verification fails, diagnose and repair through an in-scope classified package; a plausible diff is not completion.