---
name: us-plan
description: Use after clarification and source inspection when planning applies in normal workflow, is selected for an eligible focused repair, or is explicitly requested. Draft an actionable plan and obtain approval before implementing that proposed plan.
---

# Plan a proposed change

Load `skill://us-concise`. Apply lane selection in `skill://us-workflow` before composing stages, even on direct loading. Use applicable research and settled decisions from `skill://us-grill-me`; inspect source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. An enabled plan switch alone does not require a new planner or approval for an eligible focused correction: current bounded authorization or prior in-scope approval suffices, subject to independent requirements. With no applicable automatic plan stage, a bounded user request may authorize implementation. An explicit plan request remains independent.

When planning is applicable and enabled in normal composition, selected and eligible for focused work, or explicitly requested, load **Native model routing** in `skill://us-workflow` before dispatching; this does not launch the workflow. The parent inspects source and owns scope, decomposition, and integration in the active workspace, never a globally selected repository. Dispatch advertised native `planner` for a bounded read-only draft. Existing mappings remain authoritative: `model: @plan` is overridden by `task.agentModelOverrides.planner`; configured roles are not observed worker metadata. Do not edit configuration. No startup flag or host override is required for the narrow session policy, which cannot bypass stronger controls.

## Inputs

Require the requested outcome, available source/research brief, repository conventions, current constraints, and unresolved risks. If an essential consequence remains unknown, return to source inspection or `skill://us-grill-me`, or mark the smallest experiment needed; do not hide an assumption.

## Dispatch and integrate one actionable plan

Give `planner` the requested outcome, research brief, repository conventions, constraints, proposed work-package boundaries, and unresolved risks. Its draft is read-only: it does not edit, delegate, launch a workflow, or request approval. The parent checks it against current evidence, resolves factual conflicts, and integrates it into one complete plan.

State:

- acceptance criteria and non-goals observable by a user or consumer;
- exact files to create or change, relevant symbols, interfaces/contracts, data migration or dependency effects, and callers that must move together;
- ordered work packages with ownership boundaries and a frontend, backend, or genuinely neither classification: frontend uses `frontend` with `@frontend` then `@implementation`, backend uses `backend` with `@backend` then `@implementation`, and only genuinely neither work—such as documentation or tooling—uses `task`/`@implementation`; split mixed packages where coherent, retain dependencies serial, and run only ready disjoint packages in parallel;
- meaningful behavioral verification for each changed surface, including an empty project; missing existing scripts is not permission to omit verification;
- test changes only where a plausible behavioral regression needs lasting coverage, plus a throwaway smoke path where that is more appropriate;
- correctness and security review scope, repair path, documentation/cleanup impact, risks, and explicit unresolved decisions.

Keep every package specific enough for its selected implementation worker: classification, names, inputs/outputs, acceptance, and evidence are concrete. Existing `task.agentModelOverrides[agentName]` always wins over agent frontmatter; optional frontend/backend role mappings do not require configuration and must not be reported as observed runtime routing. Prefer existing repository patterns and avoid speculative abstractions. Use native session plan artifacts and `todo`, not an external ledger, command family, scheduler, or workflow engine.

## Approval boundary

After integrating a selected planner draft, present the complete proposed plan once and request explicit approval before implementing it. Prefer native approval; otherwise wait for explicit conversational approval. Clarification is not approval. This gate applies to the selected plan, not every focused repair just because `plan` is enabled. Approved in-scope implementation, verification, and repair continue without routine new planning or approval; keep active normal-workflow required reviews fresh. Explain material scope changes and return them to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, configured planner route and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `planner` is absent, prohibited by a stronger host policy, or its required role selector cannot resolve, report the exact limitation. Do not invent an agent or model, silently draft the planner's work in the parent, or describe a fallback as successful `planner` routing. If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not edit code while awaiting approval.