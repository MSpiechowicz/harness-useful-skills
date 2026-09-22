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
2. Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `skill://us-workflow`; loading that guidance does not launch the workflow. Ordinary installed startup supplies the narrowly scoped session-local policy required for the selected native implementation worker after approval, including a single work package. It grants no general extra-delegation permission and does not override stronger safety constraints, existing mappings, permissions, approval, or publication boundaries. Inspect existing routing only when needed; no host override, prompt file, or startup flag is required. `us-frontend` prioritizes `@frontend` then `@implementation`; `us-backend` prioritizes `@backend` then `@implementation`; generic `task` uses `@implementation`. `task.agentModelOverrides[agentName]` always wins. Configuration is not automatic model switching and does not prove the spawned worker's model; report actual worker/model metadata separately when available.
3. Classify every approved package before dispatch: frontend packages use `us-frontend`, backend packages use `us-backend`, and only genuinely neither packages—such as documentation or tooling—use native `task`. Split a mixed package at that boundary where coherent; otherwise report why it cannot split and serialize its dependencies. Dispatch the selected native worker for every package, including exactly one package and every bounded in-scope repair. The parent coordinates the dispatch, source inspection, integration, and verification; it does not silently implement the package itself on a different model. Parallelize only genuinely independent, ready packages with disjoint owned files and settled interfaces. Serialize overlapping files, shared manifests, dependent interfaces, and their callers.
4. Give every implementation worker `skill://us-implement/references/implementation-brief.md`. Assign explicit package ownership, inputs, acceptance, and permitted scoped verification. A worker must not launch the full workflow, delegate again, publish work, or edit outside its assignment.
5. Inspect worker output and changed source before accepting it. A worker's completion claim is evidence to check, not proof.
6. Verify the combined changed surface after all required packages settle. Exercise the actual UI, CLI, API, job, or other changed surface when possible; otherwise use a focused smoke script and report that limitation. Keep a lasting test only when it protects a plausible consumer-visible regression.

Use review findings to define bounded in-scope repair packages, classify them, and dispatch them through the selected native worker. After repair, rerun affected verification and return to `skill://us-review` followed by `skill://us-check-security`; the reviews must be fresh.

## Completion evidence

Report actual files and interfaces changed, work-package classification and ownership, configured selected-worker routing and observed worker/model metadata when available, commands or observed changed-surface behavior, test/regression evidence where retained, and limitations. Hand this evidence to `skill://us-review`.

## Failure behavior

Respect stronger host policies. If the selected native worker is absent, prohibited, or has no allowed configured/frontmatter/native route, complete only other independently dispatchable packages and report the exact limitation. Do not invent an agent or model, alter configuration, silently substitute parent implementation, or count a fallback as successful requested routing. If verification fails, diagnose and repair the implementation through an in-scope classified work package; do not call it complete because the diff looks plausible.