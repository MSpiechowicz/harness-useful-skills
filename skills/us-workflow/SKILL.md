---
name: us-workflow
description: Use automatically for a natural request to build, fix, change, or refactor software. Compose the owned us-* development skills with native tools; do not start this workflow for ordinary explanations or an explicitly focused audit.
---

# Useful Skills development workflow

Load `skill://us-concise` before preparing workflow context or human-facing prose. This is guidance for an agent, not a runtime, state machine, approval receipt, or executor. Use native `todo` to make the work visible; use the session plan, transcript, and repository as the handoff record.

## Inputs

Establish the requested outcome, relevant repository, explicit constraints, and whether the request is a development request. Treat a prior plan, todo, transcript, or memory result as evidence, not authority: inspect current files before resuming interrupted work.

## Native model routing

This section is shared routing guidance, not an instruction to launch the full workflow. Follow it before spawning workers, including when a planning, research, implementation, or review skill is invoked directly.

1. Inspect only the active OMP configuration's `modelRoles` and `task.agentModelOverrides`. Use `omp config path` to identify the active profile and agent directory; respect project `.omp/config.yml`, explicit overlays, and runtime overrides. `omp config get modelRoles --json` and `omp config get task.agentModelOverrides --json`, run with the session's profile, working directory, and overlays, show persisted effective settings only. They cannot prove in-memory session overrides or a spawned worker's model.
2. Dispatch the advertised native agent type for each stage: planning uses `us-planner`, research uses `scout`, implementation uses `task`, correctness uses `reviewer`, and security uses `security-reviewer`. The `us-planner` registration declares `model: @plan`; the recommended aliases for the other stages are `@research`, `@implementation`, `@review`, and `@security`. Existing user mappings remain authoritative.
3. OMP resolves `task.agentModelOverrides[agentName]` before an agent's frontmatter and native fallback, then expands role aliases through `modelRoles`. Thus an override for `us-planner` wins over its `@plan` frontmatter. Dispatch by native agent type; do not pass an unsupported model field, invent an agent/model/router, hard-code model names in prompts, or change user configuration. Report configured routing separately from a spawned worker's observed model, and only report the latter when runtime metadata supplies it.
4. The parent completes research, scopes and decomposes the work, then dispatches `us-planner` to draft a bounded plan from that evidence. The parent checks and integrates that draft into one plan submission and owns the single approval request; the planner does not edit, delegate, launch a workflow, or grant approval. After approval, the parent dispatches the native `task` worker for every implementation work package, including one package. The parent coordinates workers, inspects their output/source, integrates work, and verifies the combined surface; it does not silently perform planning or implementation on a different model.
5. Parallelize only ready, independent slices with disjoint owned files and settled interfaces. Serialize slices that share files, manifests, or interfaces, or whose inputs depend on an earlier slice. A stage-specific fallback expressly permitted by its own skill may be used only when host policy allows and must be reported as a fallback, not as successful routing to the requested agent.
6. If the required worker is absent, dispatch is prohibited by a stronger host policy, the selector/role is unresolved, or runtime capability is unavailable, report the exact limitation. Do not invent an agent or model, edit configuration, silently substitute parent work, or describe fallback execution as the requested routing. Inspect only routing keys; never send whole configuration files, credentials, or unrelated settings to workers or persist them in reports.

## Compose the work

1. Load `skill://us-grill-me` to assess consequential decisions. A precise request may need no questions.
2. Load `skill://us-research` before planning, including for a small change.
3. After clarification and research, the parent scopes and decomposes the proposed work, then loads `skill://us-plan`. It dispatches `us-planner` with the bounded evidence and integrates its plan draft into one implementation plan. Request explicit user approval before editing.
4. After approval, load `skill://us-implement`. Dispatch the native `task` worker for every work package, including a single package; dispatch independent ready packages together only when their ownership is disjoint, and serialize shared or dependent work.
5. Verify the combined changed surface, then load `skill://us-review` for a fresh correctness review against the approved acceptance. Next load `skill://us-check-security` for a fresh security review.
6. Route each bounded in-scope repair through `skill://us-implement` and a native `task` work package. Re-run affected verification, then obtain both fresh reviews again. After three unsuccessful repair rounds or repeated no-progress findings, preserve the work and explain the blocker; never weaken acceptance to end the loop.
7. Prepare a concise summary of the verified work, then load `skill://us-memory` to refresh code relationships and persist only durable facts. Report its observed outcome honestly.

Scale the depth, not the required outcomes: research, correctness review, security review, and memory remain required. A materially changed scope returns to the user with the change explained. Plan approval authorizes implementation and in-scope repair only; it never authorizes commits, pushes, merges, releases, or PRs. Load the separate delivery skill only after an explicit delivery request.

## Completion evidence

Before saying development work is complete, confirm the requested behavior, research evidence, explicit plan approval, combined verification, fresh correctness review, fresh security review, repairs and re-reviews when needed, concise summary, and the actual memory outcome. If any item is absent, return to that skill rather than inventing a receipt.

## Failure behavior

Do not force a stage, invoke legacy commands, use an external agent catalog, or add workflow code to recover from a failure. Respect stronger host policies. Report unavailable or prohibited workers, unresolved routing, and unmet independent-review requirements with the completed evidence; do not claim the full workflow completed or silently replace required planner or implementation dispatch with parent work.