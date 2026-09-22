---
name: us-plan
description: Use automatically after clarification and source research to turn a software request into an actionable, reviewable implementation plan with one explicit approval request before edits.
---

# Plan a proposed change

Load `skill://us-concise`. Use evidence from `skill://us-research` and settled decisions from `skill://us-grill-me`; inspect additional source only to close a concrete gap. A plan is a human-readable handoff, not a workflow database.

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `skill://us-workflow`; that guidance does not launch the workflow. Ordinary installed startup supplies the narrowly scoped session-local policy required for the bounded planner stage, so no host override, prompt file, or extra startup flag is needed. The parent must first complete research and own scope, decomposition, and integration in the active session workspace; it never selects a repository globally. It then dispatches the advertised native `planner` worker to draft a bounded implementation plan from that evidence. Existing mappings remain authoritative. The registration declares `model: @plan`; `task.agentModelOverrides.planner` takes precedence, and OMP uses its native fallback only after frontmatter. Neither configuration nor frontmatter proves the running worker's model. Do not pass a model, switch models, or edit user configuration. Report configured routing separately from actual worker/model metadata when available. Stronger host policy can still prohibit the stage.

## Inputs

Require the requested outcome, research brief, repository conventions, current constraints, and unresolved risks. If an essential consequence remains unknown, return to `skill://us-grill-me` or mark the smallest experiment needed; do not hide an assumption.

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

After integrating the planner draft, present the complete plan once and request explicit user approval before implementation. Native plan approval is preferred when available; otherwise wait for an explicit conversational approval. A clarification answer is not approval. Once approved, in-scope implementation, verification, and repair continue without routine extra gates. A material scope change must be explained and returned to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, configured planner route and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `planner` is absent, prohibited by a stronger host policy, or its required role selector cannot resolve, report the exact limitation. Do not invent an agent or model, silently draft the planner's work in the parent, or describe a fallback as successful `planner` routing. If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not edit code while awaiting approval.