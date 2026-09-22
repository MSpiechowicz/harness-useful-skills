---
name: us-plan
description: Use automatically after clarification and source research to turn a software request into an actionable, reviewable implementation plan with one explicit approval request before edits.
---

# Plan an approved change

Load `skill://us-concise`. Use the evidence from `skill://us-research` and settled decisions from `skill://us-grill-me`; inspect additional source only to close a concrete gap. A plan is a human-readable handoff, not a workflow database.

## Inputs

Require the requested outcome, research brief, repository conventions, current constraints, and unresolved risks. If an essential consequence remains unknown, return to `skill://us-grill-me` or mark the smallest experiment needed; do not hide an assumption.

## Produce one actionable plan

State:

- acceptance criteria and non-goals observable by a user or consumer;
- exact files to create or change, relevant symbols, interfaces/contracts, data migration or dependency effects, and callers that must move together;
- ordered tasks with ownership boundaries, including which ready tasks can run in parallel and which must stay serial because they share files, manifests, or interfaces;
- meaningful behavioral verification for each changed surface, including an empty project; missing existing scripts is not permission to omit verification;
- test changes only where a plausible behavioral regression needs lasting coverage, plus a throwaway smoke path where that is more appropriate;
- correctness and security review scope, repair path, documentation/cleanup impact, risks, and explicit unresolved decisions.

Make each task specific enough for a fresh worker: names, inputs/outputs, acceptance, and evidence are concrete. Prefer existing repository patterns and avoid speculative abstractions. Use native session plan artifacts and `todo`, not an external ledger, command family, or scheduler.

## Approval boundary

Present the complete plan once and request explicit user approval before implementation. Native plan approval is preferred when available; otherwise wait for an explicit conversational approval. A clarification answer is not approval. Once approved, in-scope implementation, verification, and repair continue without routine extra gates. A material scope change must be explained and returned to the user.

Approval does not authorize commits, pushes, merges, releases, or PRs.

## Completion evidence

The plan records the research evidence it relies on, exact acceptance, owned file boundaries, interfaces, dependencies, concurrency decisions, verification, and the single pending approval. Do not report it approved until the user actually approves it.

## Failure behavior

If research evidence conflicts or the plan would require undeclared scope, surface the conflict and return to research or the user. Do not fabricate a plan to preserve momentum and do not edit code while awaiting approval.