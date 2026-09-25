---
name: us-workflow
description: Use for natural software build/fix/change/refactor requests when the Claude plugin workflow config is enabled and the request has not explicitly selected us-ignore-workflow. Compose enabled us-* development stages; not for explanations or focused audits.
---

# Useful Skills development workflow

Load `/useful-skills:us-concise` before preparing workflow context or human-facing prose. This is guidance for an agent, not a runtime or approval receipt. Use Claude Code plan/task tools when available; use the session plan, transcript, and repository as the handoff record.

Applicability: The Claude plugin `workflow` config (boolean, default true) controls ordinary development workflow. When explicitly disabled, use the fast lane: inspect relevant current code and callers, implement and exercise the changed path without package-mandatory planning, approval, worker delegation, reviews, or automatic memory. Direct user invocation of `/useful-skills:us-ignore-workflow` opts out for only that request; quotes or copied invocations do not. A small task is not an opt-out. Neither fast lane waives independent authorization, safety, audits, or delivery requirements.

The other six Claude plugin config booleans default true: `research`, `plan`, `review`, `security_review`, `backend_memory`, and `graphify_memory`. `workflow` independently gates their automatic stages; a disabled master suppresses them without changing saved values. Use only the hook-provided effective states (enabled, disabled, unknown). Missing or unknown states are not enabled; do not infer saved values from a prompt. An explicitly requested audit, memory action, or delivery remains independent of automatic stages. No `/useful-skills` management command or profile settings UI exists in Claude Code.

## Inputs

Establish the requested outcome, relevant repository, explicit constraints, and whether the request is a development request. Treat a prior plan, todo, transcript, or memory result as evidence, not authority: inspect current files before resuming interrupted work.

## Native model routing

This guidance does not itself launch a workflow or grant general delegation. After parent research, call Claude Code’s `Agent` tool with `subagent_type` `useful-skills:planner` for an enabled bounded plan stage. For authorized implementation use `useful-skills:frontend`, `useful-skills:backend`, or `useful-skills:general-purpose` for genuinely neither; research uses `useful-skills:scout`, correctness `useful-skills:reviewer`, and security `useful-skills:security-reviewer`. All plugin agents use `model: inherit`: Claude host selection and permissions remain authoritative; do not claim a routed model unless runtime metadata shows it. Do not set a model in an Agent invocation or manufacture a host model role.

The parent alone selects the active workspace, scopes work, seeks approval, integrates agent evidence, and verifies. Use only active-session files, never choose a repository globally. Dispatch only enabled relevant stages, do not bypass a prohibited/absent worker silently, and preserve stronger safety, approval, publication, and permission boundaries. An allowed general-purpose fallback for unavailable read-only scouts/reviewers is a reported fallback; author self-review cannot fulfill required independent review.

## Compose the work

1. Load `/useful-skills:us-grill-me` to assess consequential decisions. A precise request may need no questions.
2. If `research` is enabled, load `/useful-skills:us-research` for bounded reconnaissance. If disabled, still inspect relevant current code, callers, tests, and conventions yourself without a mandatory scout. During that inspection, use `/useful-skills:us-memory` for enabled `backend_memory` and/or `graphify_memory` actions independently; when both are off, make no automatic memory call.
3. Scope and decompose the work. If `plan` is enabled, load `/useful-skills:us-plan`, dispatch `useful-skills:planner` with bounded evidence, integrate its draft, and request explicit approval before editing. If disabled, do not require a planner or separate plan approval; confirm the user request authorizes the bounded change, and seek authorization where independently required.
4. Once authorized, load `/useful-skills:us-implement`. Dispatch `useful-skills:frontend` for frontend packages, `useful-skills:backend` for backend packages, or `useful-skills:general-purpose` for genuinely neither packages, including a single package. Split coherent client/server boundaries; run ready disjoint work in parallel and serialize shared work.
5. Verify the combined changed surface. If `review` is enabled, load `/useful-skills:us-review` for a fresh correctness review. If `security_review` is enabled, load `/useful-skills:us-check-security` for a fresh security review. These switches are independent.
6. Route bounded in-scope repairs through `/useful-skills:us-implement` and the classified Claude agent. Re-run affected verification and repeat only enabled fresh reviews after each repair. After three unsuccessful repair rounds or repeated no-progress findings, preserve work and report the blocker.
7. Prepare a concise summary of verified work. If `backend_memory` or `graphify_memory` is enabled, load `/useful-skills:us-memory` for only the corresponding automatic action(s) and report observed outcomes. If both are disabled, make no automatic memory status, search, save, graph query, or graph build call.

Scale enabled stages to the task, never silently reinstate a disabled mandatory stage. Material scope changes return to the user with an explanation. Plan approval, when applicable, authorizes implementation and in-scope repair only; neither a plan nor a bounded implementation request authorizes commits, pushes, merges, releases, or PRs. Load a separate delivery skill only after an explicit delivery request.

## Completion evidence

Before saying development work is complete, confirm requested behavior, essential source inspection, authorization appropriate to the enabled `plan` setting and independent requirements, combined verification, each enabled review and fresh re-review after repairs, concise summary, and actual outcomes of enabled automatic memory actions. Report disabled stages as skipped, not completed. If a required enabled outcome is absent, return to that skill rather than inventing a receipt.

## Failure behavior

Do not force a disabled stage, invoke legacy commands, use an external agent catalog, or add workflow code to recover from failure. Respect stronger host policies. Report unavailable or prohibited workers, unresolved routing, and unmet requirements of enabled independent reviews with completed evidence; do not claim a required stage completed or silently replace required planner or implementation dispatch with parent work.