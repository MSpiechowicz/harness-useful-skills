---
name: us-plan
description: "Use before editing when a plan is needed: \"plan this\", \"make a plan first\", \"how would you implement X\", or when the plan stage applies in the workflow. Drafts one actionable plan with acceptance criteria, file-level work packages, and verification, then asks for explicit approval before any edits."
---

# Plan a proposed change

Load the `us-write-concisely` skill. Apply lane selection in the `us-run-workflow` skill before composing stages, even on direct loading. Load the `us-grill-me` skill when any user-owned choice is open and plan only on settled decisions; inspect source to close concrete gaps. A plan is a human-readable handoff, not a workflow database. The plan stage alone does not require a new planner or approval for an eligible focused correction: current bounded authorization or prior in-scope approval suffices, subject to independent requirements. With no applicable automatic plan stage, a bounded user request may authorize implementation. An explicit plan request remains independent.

When planning is applicable in normal composition, selected and eligible for focused work, or explicitly requested, read **Native model routing** in the `us-run-workflow` skill first. It does not launch the workflow. Pi has no worker tool: inspect source, then draft the plan inline in the parent, which owns scope, decomposition, and integration in the active workspace, and report it as "ran inline (Pi has no worker tool)". Plan approval is still required before edits. Host permissions remain authoritative and cannot be bypassed.

## Inputs

Require the requested outcome, available source/research brief, repository conventions, current constraints, and unresolved risks. If a user-owned choice remains, load the `us-grill-me` skill and ask; if a fact is unknown, return to source inspection; if it needs a prototype or measurement, mark the smallest experiment. Do not hide an assumption.

## Draft one actionable plan

Draft the plan from the requested outcome, research brief, repository conventions, constraints, proposed work-package boundaries, and unresolved risks. Check the draft against current evidence, resolve factual conflicts, and integrate it into one complete plan. Turn open questions and unresolved user-owned choices into a round with the `us-grill-me` skill before presenting the plan, and present the plan only on settled choices.

State:

- acceptance criteria and non-goals observable by a user or consumer;
- exact files to create or change, relevant symbols, interfaces/contracts, data migration or dependency effects, and callers that must move together;
- ordered work packages with ownership boundaries and a frontend, backend, or genuinely neither classification to set order and ownership (Pi implements every package inline in the parent). Split mixed packages where coherent and keep dependencies serial;
- meaningful behavioral verification for each changed surface, including an empty project; missing existing scripts is not permission to omit verification;
- test changes only where a plausible behavioral regression needs lasting coverage, plus a throwaway smoke path where that is more appropriate;
- correctness and security review scope, repair path, documentation/cleanup impact, risks, and explicit unresolved decisions.

Keep every package specific enough to implement: classification, names, inputs/outputs, acceptance, and evidence are concrete. Prefer existing repository patterns and avoid speculative abstractions. Keep a short task list in the conversation, not an external ledger, command family, scheduler, or workflow engine.

## Approval boundary

After drafting the selected plan, present the complete proposed plan once and request explicit approval before implementing it. Ask for approval in plain chat and end the turn. Clarification is not approval. This gate applies to the selected plan, not every focused repair just because the plan stage exists. Approved in-scope implementation, verification, and repair continue without routine new planning or approval; keep active normal-workflow required reviews fresh. Explain material scope changes and return them to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

Record the research evidence, the note that planning ran inline (Pi has no worker tool), exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If planning is prohibited by a stronger host policy, report the exact limitation. If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not edit code while awaiting approval.