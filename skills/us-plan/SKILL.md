---
name: us-plan
description: Use after clarification and source inspection when the profile's plan stage is enabled, or when explicitly requested, to draft an actionable implementation plan and obtain the required approval before edits.
---

# Plan a proposed change

Load `skill://us-concise`. Use available evidence from `skill://us-research` when enabled and settled decisions from `skill://us-grill-me`; inspect additional source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. When automatic `plan` is disabled, this skill imposes no planner dispatch or separate plan approval on ordinary implementation; a bounded user request can authorize it, subject to independent authorization requirements. An explicitly requested plan is separate from that automatic stage.

When `plan` is enabled or a plan is explicitly requested, load the **Native model routing** guidance in `skill://us-workflow` before dispatching; that guidance does not launch the workflow. Ordinary installed startup supplies the narrowly scoped session-local policy for the bounded planner stage, so no host override, prompt file, or extra startup flag is needed. The parent first inspects source and owns scope, decomposition, and integration in the active session workspace; it never selects a repository globally. It dispatches the advertised native `planner` worker to draft a bounded implementation plan from available evidence. Existing mappings remain authoritative. The registration declares `model: @plan`; `task.agentModelOverrides.planner` takes precedence, and OMP uses native fallback only after frontmatter. Neither configuration nor frontmatter proves the running worker's model. Do not pass a model, switch models, or edit user configuration. Report configured routing separately from actual worker/model metadata when available. Stronger host policy can still prohibit the stage.

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

After integrating the planner draft, present the complete plan once and request explicit user approval before implementation. Native plan approval is preferred when available; otherwise wait for an explicit conversational approval. A clarification answer is not approval. Once approved, in-scope implementation, verification, and repair continue without routine extra gates. A material scope change must be explained and returned to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, configured planner route and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `planner` is absent, prohibited by a stronger host policy, or its required role selector cannot resolve, report the exact limitation. Do not invent an agent or model, silently draft the planner's work in the parent, or describe a fallback as successful `planner` routing. If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not edit code while awaiting approval.