---
name: us-plan
description: "Use before editing when a plan is needed: \"plan this\", \"make a plan first\", \"how would you implement X\", or when the plan stage applies in the workflow. Drafts one actionable plan with acceptance criteria, file-level work packages, and verification, then asks for explicit approval before any edits."
---

# Plan a proposed change

Load the `us-write-concisely` skill. Apply lane selection in the `us-run-workflow` skill before composing stages, even on direct loading. Load the `us-grill-me` skill when any user-owned choice is open and plan only on settled decisions; inspect source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. The plan stage alone does not require a new planner or approval for an eligible focused correction: current bounded authorization or prior in-scope approval suffices, subject to independent requirements. With no applicable automatic plan stage, a bounded user request may authorize implementation. An explicit plan request remains independent.

When planning is applicable in normal composition, selected and eligible for focused work, or explicitly requested, read **Native model routing** in the `us-run-workflow` skill before dispatching; this does not launch the workflow. The parent inspects source and owns scope, decomposition, and integration in the active workspace. Obtain a bounded read-only draft by calling the `spawn_agent` tool with `agent_type` `us-planner`, without setting `model` or `reasoning_effort`. Subagents inherit the session sandbox and approval policy, so a read-only role is enforced by instructions only: state in the `message` that the agent must not edit files, install dependencies, or publish anything. A configured model is not observed worker metadata. Do not edit configuration. Host permissions remain authoritative and cannot be bypassed.

## Inputs

Require the requested outcome, available source/research brief, repository conventions, current constraints, and unresolved risks. If a user-owned choice remains, load the `us-grill-me` skill and ask; if a fact is unknown, return to source inspection; if it needs a prototype or measurement, mark the smallest experiment. Do not hide an assumption.

## Dispatch and integrate one actionable plan

Give `us-planner` the requested outcome, research brief, repository conventions, constraints, proposed work-package boundaries, and unresolved risks. Its draft is read-only: it does not edit, delegate, launch a workflow, or request approval. The parent checks it against current evidence, resolves factual conflicts, and integrates it into one complete plan. The planner cannot ask the user: turn its open questions and unresolved user-owned choices into a round with the `us-grill-me` skill before presenting the plan, and present the plan only on settled choices.

State:

- acceptance criteria and non-goals observable by a user or consumer;
- exact files to create or change, relevant symbols, interfaces/contracts, data migration or dependency effects, and callers that must move together;
- ordered work packages with ownership boundaries and a frontend, backend, or genuinely neither classification: frontend uses `us-frontend`, backend uses `us-backend`, and only genuinely neither work—such as documentation or tooling—uses `us-general-purpose`; split mixed packages where coherent, retain dependencies serial, and run only ready disjoint packages in parallel;
- meaningful behavioral verification for each changed surface, including an empty project; missing existing scripts is not permission to omit verification;
- test changes only where a plausible behavioral regression needs lasting coverage, plus a throwaway smoke path where that is more appropriate;
- correctness and security review scope, repair path, documentation/cleanup impact, risks, and explicit unresolved decisions.

Keep every package specific enough for its selected implementation worker: classification, names, inputs/outputs, acceptance, and evidence are concrete. Prefer existing repository patterns and avoid speculative abstractions. Keep a short task list in the conversation, not an external ledger, command family, scheduler, or workflow engine.

## Approval boundary

After integrating a selected planner draft, present the complete proposed plan once and request explicit approval before implementing it. Ask for approval with `request_user_input` (approve or request changes) when available; otherwise present the plan, ask for approval in plain text, and end the turn. Clarification is not approval. This gate applies to the selected plan, not every focused repair just because the plan stage exists. Approved in-scope implementation, verification, and repair continue without routine new planning or approval; keep active normal-workflow required reviews fresh. Explain material scope changes and return them to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, planner agent type and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `us-planner` is missing, follow the fallback in **Native model routing** in the `us-run-workflow` skill and report it as a fallback, never as successful `us-planner` routing. If dispatch is prohibited by a stronger host policy or cannot resolve, report the exact limitation. Do not invent an agent or model or silently draft the planner's work in the parent. If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not edit code while awaiting approval.