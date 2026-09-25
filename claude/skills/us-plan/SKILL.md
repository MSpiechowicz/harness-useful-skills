---
name: us-plan
description: Use after clarification and source inspection when the Claude plugin's plan stage is enabled, or when explicitly requested, to draft an actionable implementation plan and obtain the required approval before edits.
---

# Plan a proposed change

Load `/useful-skills:us-concise`. Use available evidence from `/useful-skills:us-research` when enabled and settled decisions from `/useful-skills:us-grill-me`; inspect additional source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. When automatic `plan` is disabled, this skill imposes no planner dispatch or separate plan approval on ordinary implementation; a bounded user request can authorize it, subject to independent authorization requirements. An explicitly requested plan is separate from that automatic stage.

When `plan` is enabled or a plan is explicitly requested, read the **Native model routing** guidance in `/useful-skills:us-workflow` without starting the full workflow. The parent first inspects source, owns scope and integration, then dispatches `useful-skills:planner` with Claude Code’s `Agent` tool for a bounded read-only draft. All plugin agents declare `model: inherit`; host routing and permissions apply. A missing, disallowed, or unavailable agent is a limitation, not permission to substitute another stage.

## Inputs

Require the requested outcome, available source/research brief, repository conventions, current constraints, and unresolved risks. If an essential consequence remains unknown, return to source inspection or `/useful-skills:us-grill-me`, or mark the smallest experiment needed; do not hide an assumption.

## Dispatch and integrate one actionable plan

Give `useful-skills:planner` the requested outcome, research brief, repository conventions, constraints, proposed work-package boundaries, and unresolved risks. Its draft is read-only: it does not edit, delegate, launch a workflow, or request approval. The parent checks it against current evidence, resolves factual conflicts, and integrates it into one complete plan.

State:

- acceptance criteria and non-goals observable by a user or consumer;
- exact files to create or change, relevant symbols, interfaces/contracts, data migration or dependency effects, and callers that must move together;
- ordered packages with ownership boundaries and frontend, backend, or genuinely neither classification: use `useful-skills:frontend`, `useful-skills:backend`, or `useful-skills:general-purpose` respectively; split mixed packages where coherent, serialize dependencies, and parallelize only ready disjoint work;
- meaningful behavioral verification for each changed surface, including an empty project; missing existing scripts is not permission to omit verification;
- test changes only where a plausible behavioral regression needs lasting coverage, plus a throwaway smoke path where that is more appropriate;
- correctness and security review scope, repair path, documentation/cleanup impact, risks, and explicit unresolved decisions.

Keep every package specific enough for the selected Claude agent: classification, inputs/outputs, names, acceptance, and evidence. Do not report host model selection unless actual runtime metadata supplies it. Prefer established patterns; use native session planning tools rather than an external ledger or workflow engine.

## Approval boundary

After integrating the planner draft, present the complete plan once and request explicit user approval before implementation. Native plan approval is preferred when available; otherwise wait for an explicit conversational approval. A clarification answer is not approval. Once approved, in-scope implementation, verification, and repair continue without routine extra gates. A material scope change must be explained and returned to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, selected Claude plugin agent and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `useful-skills:planner` is absent or prohibited, report that exact limitation. Do not invent a model or describe a substitute as the requested planner. Resolve conflicting evidence with research or the user; do not edit while awaiting approval.