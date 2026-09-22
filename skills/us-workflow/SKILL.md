---
name: us-workflow
description: Use automatically for a natural request to build, fix, change, or refactor software. Compose the owned us-* development skills with native tools; do not start this workflow for ordinary explanations or an explicitly focused audit.
---

# Useful Skills development workflow

Load `skill://us-concise` before preparing workflow context or human-facing prose. This is guidance for an agent, not a runtime, state machine, approval receipt, or executor. Use native `todo` to make the work visible; use the session plan, transcript, and repository as the handoff record.

## Inputs

Establish the requested outcome, relevant repository, explicit constraints, and whether the request is a development request. Treat a prior plan, todo, transcript, or memory result as evidence, not authority: inspect current files before resuming interrupted work.

## Native model routing

This section is shared routing guidance, not an instruction to launch the full workflow. Follow it before spawning workers, including when a research, implementation, or review skill is invoked directly.

1. Inspect the active OMP configuration's `modelRoles` and `task.agentModelOverrides`. The default user file is `~/.omp/agent/config.yml`; use `omp config path` to identify the active profile/agent directory rather than assuming that path. Respect project `.omp/config.yml`, explicit config overlays, and runtime overrides. Native `omp config get modelRoles --json` and `omp config get task.agentModelOverrides --json` show persisted effective settings for that invocation; run them with the same profile, working directory, and overlays as the session. They cannot prove a running session's in-memory overrides.
2. Match the actual advertised agent type to its configured override: research uses `scout`, delegated implementation uses `task`, correctness uses `reviewer`, and security uses `security-reviewer`. Recommended role aliases are `@research`, `@implementation`, `@review`, and `@security`, respectively; existing user mappings remain authoritative. Follow the stage's advertised-worker fallback when a specialist is unavailable, checking the fallback agent's own routing rather than claiming it uses the missing specialist's model.
3. Dispatch by native agent type; do not pass an unsupported model field, invent a router, or hard-code model names in worker prompts. OMP resolves `task.agentModelOverrides[agentName]` before agent frontmatter and its native fallback, expanding role aliases through `modelRoles`. A missing mapping is not permission to edit configuration: retain native fallback and report that explicit role routing was unavailable. If configuration cannot be inspected or a selector cannot resolve, report the exact limitation; never claim a model was used without runtime evidence.
4. Inspect only routing keys. Never send whole configuration files, credentials, or unrelated settings to workers or persist them in reports. Report the configured routing separately from the observed spawned model when runtime metadata is available.

Planning and integration remain parent-owned. `modelRoles.plan` configures OMP's native planning selection; reading `us-plan` does not switch the current model or create a planner agent. Worker overrides likewise do not change implementation performed by the parent. Model choices belong in user configuration, not skill text.

## Compose the work

1. Load `skill://us-grill-me` to assess consequential decisions. A precise request may need no questions.
2. Load `skill://us-research` before planning, including for a small change.
3. Load `skill://us-plan` after clarification and research. Present one implementation plan and wait for explicit user approval before editing.
4. After approval, load `skill://us-implement`. Delegate genuinely independent, disjoint work with native `task`/`hub`; keep shared files and dependencies serial.
5. Verify the combined changed surface, then load `skill://us-review` for a fresh correctness review against the approved acceptance. Next load `skill://us-check-security` for a fresh security review.
6. Repair verified acceptance failures and material security findings through `skill://us-implement`. Re-run affected verification, then obtain both fresh reviews again. After three unsuccessful repair rounds or repeated no-progress findings, preserve the work and explain the blocker; never weaken acceptance to end the loop.
7. Prepare a concise summary of the verified work, then load `skill://us-memory` to refresh code relationships and persist only durable facts. Report its observed outcome honestly.

Scale the depth, not the required outcomes: research, correctness review, security review, and memory remain required. A materially changed scope returns to the user with the change explained. Plan approval authorizes implementation and in-scope repair only; it never authorizes commits, pushes, merges, releases, or PRs. Load the separate delivery skill only after an explicit delivery request.

## Completion evidence

Before saying development work is complete, confirm the requested behavior, research evidence, explicit plan approval, combined verification, fresh correctness review, fresh security review, repairs and re-reviews when needed, concise summary, and the actual memory outcome. If any item is absent, return to that skill rather than inventing a receipt.

## Failure behavior

Do not force a stage, invoke legacy commands, use an external agent catalog, or add workflow code to recover from a failure. If native worker capability is unavailable, use the advertised general-purpose worker with the relevant brief. If a required review or memory operation cannot be completed, report the concrete limitation and all completed evidence; do not claim the full workflow completed.