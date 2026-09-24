---
name: us-improve-codebase-architecture
description: Inspect a scoped codebase area for evidence-backed architectural improvements, then route a user-selected change through the owned development workflow.
---

# Improve codebase architecture

Load `skill://us-concise` before preparing findings. This skill begins as a read-only architecture investigation. It surfaces candidates and does not authorize refactoring, code changes, documentation changes, publication, or a new workflow run.

## Inputs and scope

Establish the requested outcome, named subsystem or pain point, current checkout, repository guidance, and relevant constraints. Scope before inspecting broadly:

1. Prefer an explicitly named area, recurring defect, change request, or current change hotspot.
2. Otherwise, inspect a bounded stretch of available history to identify recurring paths and recent change hotspots. If Git is unavailable, history is absent, or changes are too scattered, say so and use the request plus a small, coherent source area; do not fail or fabricate history.
3. Read only the source, callers, tests, configuration, and documentation needed to understand that area. Treat an empty project as an inspected result, not an invitation to scaffold an architecture.
4. Look for a domain glossary, `CONTEXT.md`, architecture documents, and ADRs that govern the scoped area. Use their settled domain vocabulary and decisions where present. Missing documentation is a limitation to report, not permission to create or update it.

## Read-only investigation

Trace the actual consumer-facing path and its callers before judging structure. Seek evidence, not a generic catalogue of code smells:

- **Domain vocabulary and seams:** identify the business concepts, data ownership, entry points, and dependencies that make a meaningful seam possible.
- **Shallow abstractions:** inspect whether an interface exposes nearly as much complexity as it hides, especially wrappers, pass-through modules, and one-off helpers.
- **Coupling and locality:** find cases where changing or understanding one domain concept requires traversing unrelated files, where details leak across a seam, or where orchestration scatters policy.
- **Testability:** distinguish a valuable interface that allows consumer-observable behavior to be tested from functions extracted only to mock or unit-test implementation details.
- **Deletion test:** for a suspected abstraction, ask whether deleting it would concentrate and reduce complexity, rather than merely move complexity elsewhere. A candidate must explain the result; deletion is not automatically a virtue.

Do not prescribe object-oriented design, layers, interfaces, adapters, or consolidation merely because a pattern is familiar. Retain an abstraction when it protects a real contract, isolates volatile detail, or improves locality and leverage. Respect applicable ADRs; surface a tension only when observed friction gives a concrete reason to reconsider the decision.

## Candidate report

Present only a small, prioritized set of evidence-backed candidates. Keep the report in the conversation or a user-requested repository artifact; do not require HTML, a CDN, a browser, or an external reporting tool. For every candidate, include:

- **Scope and evidence:** exact paths and symbols, relevant callers/tests, and the observed relationship or change hotspot.
- **Problem:** the concrete friction in domain terms, including the shallow interface, coupling, locality, or testability concern.
- **Deletion test:** what deletion or consolidation would remove, preserve, or merely relocate.
- **Recommendation:** the smallest coherent structural change, plus affected contracts, callers, tests, and any ADR tension.
- **Tradeoffs:** costs, risks, deferred alternatives, and reasons not to make the change where applicable.
- **Before / after diagram:** a compact text or Mermaid diagram that distinguishes the existing dependency or responsibility flow from the proposed one.
- **Strength:** exactly `Strong`, `Worth exploring`, or `Speculative`, based on evidence quality, user value, and change risk.

End with one top recommendation and why it has the best evidence-to-risk ratio. If no candidate meets this bar, say that the scoped investigation found none, list what was inspected and its limitations, and make no speculative refactor proposal.

## Authorization and selected change

A report, a top recommendation, and a user's interest in a candidate are not by themselves authorization to edit. Ask which candidate, if any, the user wants to explore and whether they authorize a bounded change. For a selected, authorized candidate, use enabled owned stages directly rather than recursively starting `skill://us-workflow`:

1. Inspect current source, callers, tests, and conventions. When automatic `research` is enabled, load `skill://us-research`; enabled backend/graph memory actions during inspection follow `skill://us-memory` independently.
2. Load `skill://us-grill-me` only for consequential unresolved decisions; a precise, evidence-backed selection needs no invented questions.
3. When automatic `plan` is enabled, load `skill://us-plan` to produce one actionable plan and obtain explicit approval before edits. Otherwise a bounded user request can authorize implementation without a mandatory planner or separate plan approval; preserve any independent approval requirement.
4. Once authorized, load `skill://us-implement`. Preserve established contracts and consumer behavior; migrate affected callers together, maintain meaningful tests, and avoid unrelated cleanup.
5. Obtain fresh correctness review through `skill://us-review` only if `review` is enabled and security review through `skill://us-check-security` only if `security-review` is enabled. After verified work and enabled reviews, use `skill://us-memory` only for enabled backend/graph actions.

The selected change remains bounded by its authorization. A material interface, behavior, dependency, or scope change returns to the user (and to planning when enabled); it never becomes an architectural workaround. Do not automatically edit domain documents, `CONTEXT.md`, ADRs, or any architecture record. Propose such an edit separately only when the user authorizes it.

## Completion and failure behavior

For an investigation, return the inspected scope, evidence, candidates (or none), top recommendation when one exists, tradeoffs, missing documentation/history limitations, and the explicit next authorization needed. Do not claim the repository is well-architected outside the inspected area.

If source access, relevant history, or documentation is unavailable, complete the bounded inspection from available evidence and state the gap. If the project is empty or has no credible candidate, report that outcome without scaffolding, placeholders, or a forced abstraction.

## Attribution

Inspired by the pinned upstream reference: <https://raw.githubusercontent.com/mattpocock/skills/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/improve-codebase-architecture/SKILL.md>. This owned skill intentionally adapts its architectural-review ideas to native `us-*` stages and does not require upstream-only skills or reporting infrastructure.
