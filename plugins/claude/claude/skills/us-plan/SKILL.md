---
name: us-plan
description: Drafts one actionable implementation plan with acceptance criteria, file-level work packages, and verification, then asks for explicit approval before any edits. Use when the user says "plan this", "make a plan first", or "how would you implement X", or when the plan stage applies in the development workflow or is selected for a focused repair.
---

# Plan a proposed change

Load `/useful-skills:us-write-concisely`. Apply lane selection in `/useful-skills:us-run-workflow` before composing stages, even on direct loading. Load `/useful-skills:us-grill-me` when any user-owned choice is open and plan only on settled decisions; inspect source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. An enabled plan switch alone does not require a new planner or approval for an eligible focused correction: current bounded authorization or prior in-scope approval suffices, subject to independent requirements. With no applicable automatic plan stage, a bounded user request may authorize implementation. An explicit plan request remains independent.

When planning is applicable and enabled in normal composition, selected and eligible for focused work, or explicitly requested, read **Native model routing** in `/useful-skills:us-run-workflow` without starting the full workflow. The parent inspects source, owns scope and integration, and dispatches `useful-skills:planner` with Claude Code’s `Agent` tool for a bounded read-only draft. Enabled `plan` alone does not force focused planning or re-approval. Plugin agents use `model: inherit`; when Useful Skills session context lists a configured `/useful-skills:us-planner` role agent, dispatch it instead with the same brief. Host permissions remain authoritative. A missing or prohibited required agent is a limitation, not permission to substitute another stage.

## Inputs

Require the requested outcome, available source/research brief, repository conventions, current constraints, and unresolved risks. If a user-owned choice remains, load `/useful-skills:us-grill-me` and ask; if a fact is unknown, return to source inspection; if it needs a prototype or measurement, mark the smallest experiment. Do not hide an assumption.

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

After integrating a selected planner draft, present the complete proposed plan once and request explicit approval before implementing it. Prefer native approval; otherwise wait for explicit conversational approval. Clarification is not approval. This gate applies to the selected plan, not every focused repair just because `plan` is enabled. Approved in-scope implementation, verification, and repair continue without routine new planning or approval; keep active normal-workflow required reviews fresh. Explain material scope changes and return them to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, selected Claude plugin agent and any observed worker metadata, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If `useful-skills:planner` is absent or prohibited, report that exact limitation. Do not invent a model or describe a substitute as the requested planner. Resolve conflicting evidence with research or the user; do not edit while awaiting approval.