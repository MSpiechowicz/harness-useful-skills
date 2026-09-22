---
name: us-implement
description: Use automatically after the user has approved a software implementation plan, or to repair a correctness or security finding within that approved scope. Implement through native tools, delegated independent work, and observable verification.
---

# Implement the approved plan

Load `skill://us-concise`. Read the approved plan, current files, and relevant evidence before changing anything; interrupted work may have drifted. Use native `todo` to reflect work, but let current source and observed verification—not task status—determine completion.

## Inputs

Require the approved plan and acceptance, current source, research evidence, declared worker ownership, and the changed-surface verification path.

## Scope and authority

Implement only approved tasks and repairs that satisfy their acceptance. The approval permits no publication action: do not commit, push, merge, open a PR, release, or alter unrelated work unless separately authorized. A material scope or interface change returns to the user through `skill://us-plan` rather than becoming an undocumented workaround.

## Work method

1. Reuse the repository's established implementation and test patterns. For a bug or genuinely uncertain new behavior, establish a behavioral regression that fails before the fix and passes after it. Do not retain tests that merely pin wording, source text, mocks, forwarding, or incidental implementation details.
2. Use native `task`/`hub` only for genuinely independent, ready tasks with disjoint owned files and settled interfaces. Dispatch those tasks together. Keep overlapping files, shared manifests, and dependent interfaces serial. Use only worker kinds advertised by the native tool; a general-purpose worker may carry a role brief when needed.
3. Give every implementation worker `skill://us-implement/references/implementation-brief.md`. Assign explicit file ownership and inputs. A worker must not launch the full workflow, publish work, or edit outside its assignment.
4. Inspect worker output and changed source before accepting it. A worker's completion claim is evidence to check, not proof.
5. Verify the combined changed surface after the parallel wave settles. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use review findings to perform in-scope repairs. After repair, rerun affected verification and return to `skill://us-review` followed by `skill://us-check-security`; the reviews must be fresh.

## Completion evidence

Report actual files and interfaces changed, workers and ownership used, commands or observed changed-surface behavior, test/regression evidence where retained, and limitations. Hand this evidence to `skill://us-review`.

## Failure behavior

Do not replace a source fix with suppression, a special case, or a fake fallback. If a worker cannot proceed, complete other independent work and report the concrete block. If verification fails, diagnose and repair the implementation; do not call it complete because the diff looks plausible.