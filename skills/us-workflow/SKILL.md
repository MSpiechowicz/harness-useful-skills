---
name: us-workflow
description: Use automatically for a natural request to build, fix, change, or refactor software. Compose the owned us-* development skills with native tools; do not start this workflow for ordinary explanations or an explicitly focused audit.
---

# Useful Skills development workflow

Load `skill://us-concise` before preparing workflow context or human-facing prose. This is guidance for an agent, not a runtime, state machine, approval receipt, or executor. Use native `todo` to make the work visible; use the session plan, transcript, and repository as the handoff record.

## Inputs

Establish the requested outcome, relevant repository, explicit constraints, and whether the request is a development request. Treat a prior plan, todo, transcript, or memory result as evidence, not authority: inspect current files before resuming interrupted work.

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