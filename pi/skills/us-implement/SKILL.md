---
name: us-implement
description: "Use once a change is authorized: the user approves a plan (\"go ahead\", \"implement it\"), makes a bounded request with no plan stage, or review findings need in-scope repair. Implements inline in the parent and verifies the changed path by running it."
---

# Implement the authorized change

Load the `us-write-concisely` skill. Apply the pre-composition lane selection in the `us-run-workflow` skill even when loading this skill directly; loading guidance does not launch a full workflow. Read current source/callers, acceptance, available research, and the applicable authorization: approved plan for a selected plan stage, prior in-scope approval for its repairs, or the bounded current request when no plan stage applies (including an eligible focused repair). The plan stage alone does not impose a new approval on focused work. Interrupted work may have drifted. Keep a short task list in the conversation to reflect work, but let current source and observed verification—not task status—determine completion.

## Inputs

Require authorized scope and acceptance, current source/callers, available evidence, the selected lane and any required stages, ownership when delegating, and the changed-surface verification path.

## Scope and authority

Implement only authorized tasks and repairs that satisfy acceptance. Neither plan approval nor a bounded user request permits publication: do not commit, push, merge, open a PR, release, or alter unrelated work unless separately authorized. A material scope or interface change returns to the user and normal composition; use the `us-plan` skill when its stage applies rather than an undocumented workaround. Prior approval covers in-scope repair without routine new planning or approval.

## Work method

An eligible focused correction may be implemented inline by the parent after source/caller inspection, then observably verified and reported. It does not require delegation, planning, full reviews, or memory solely because those stages exist. Select extra eligible stages for actual uncertainty, contracts, findings, or security/memory impact; preserve independent requests. An active normal workflow retains its required reviews after repairs; do not reclassify it to omit them.

When the change alters how a UI element looks or behaves, load the `us-keep-ui-consistent` skill before editing. Its same-pattern sibling instances are part of the authorized change: place every instance to fix inside a package's owned files and include its instance table in the completion evidence. Adding same-pattern sibling files to a package's ownership needs no new approval; a sibling fix that needs an interface change or a different kind of work, a sibling in another app or package, or a shared component or token consumed by other apps or packages, is material scope and returns to the user.

1. Reuse the repository's established implementation and test patterns. Keep code easy to read: group related declarations with the logic that uses them, separate distinct logical stages and conditional branches with whitespace rather than packing declarations or `if`/`return` statements together, and favor straightforward control flow. Expand complex inline conditionals into clear branches; simple inline cases are fine when clear. For a bug or genuinely uncertain new behavior, establish a behavioral regression that fails before the fix and passes after it. Do not retain tests that merely pin wording, source text, mocks, forwarding, or incidental implementation details.
2. Before implementing—even when this skill is invoked directly—read **Native model routing** in the `us-run-workflow` skill. Reading that guidance does not launch the workflow. Pi has no worker tool: implement every authorized package inline in the parent and report it as "ran inline (Pi has no worker tool)". This grants no bypass of permissions, approval, or publication boundaries.
3. Classify every authorized package as frontend, backend, or genuinely neither—such as documentation or tooling—to set order and ownership. Split mixed packages where coherent, otherwise explain the boundary and serialize dependencies. Implement one package at a time in the parent and serialize shared files/manifests, interfaces, and callers. Do not invent model metadata.
4. Read `references/implementation-brief.md` relative to this skill's base directory, fill it for each package, and follow it as your own brief: explicit package ownership, inputs, acceptance, and permitted scoped verification. Do not launch the full workflow, publish work, or edit outside the assignment.
5. Re-read your changed source before accepting it. A completion claim is evidence to check, not proof.
6. Verify the combined changed surface after all required packages settle. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use findings from required or selected reviews for bounded in-scope repairs. Active normal-workflow repairs run inline in the parent, and a simple review finding (local, low-risk, obvious) gets a re-review scoped to the repaired lines; each review stage stops after three passes once no High finding is open and reports any Medium or lower findings to the user to decide, while a High finding keeps the loop going with fresh full-scope reviews; eligible focused repairs may remain inline. Rerun affected verification, then obtain fresh required or selected the `us-review` skill and/or the `us-check-security` skill reviews over affected changes. Do not reuse earlier review evidence for newly changed code, restart unrelated stages, or require routine re-approval within scope.

## Completion evidence

Report actual files/interfaces changed, selected lane and reason, package classification, "ran inline (Pi has no worker tool)", observed changed-surface verification, retained behavioral regressions, and limitations. Hand evidence to required or selected reviews; state omitted stages as skipped, not completed. Inline focused repair needs no invented worker metadata or plan.

## Failure behavior

Respect stronger host policies. If implementation is prohibited by a stronger host policy, complete only independently reachable work and report the exact limitation. Do not change configuration. If verification fails, diagnose within scope and the active lane, retaining required fresh reviews; a plausible diff is not completion.