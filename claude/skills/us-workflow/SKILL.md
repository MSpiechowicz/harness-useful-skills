---
name: us-workflow
description: Use for natural software build/fix/change/refactor requests when the Claude plugin workflow config is enabled and the request has not explicitly selected us-ignore-workflow. Triage focused repairs before composing applicable enabled us-* stages; not for explanations or focused audits.
---

# Useful Skills development workflow

Load `/useful-skills:us-concise` before preparing workflow context or human-facing prose. This is guidance for an agent, not a runtime or approval receipt. Use Claude Code plan/task tools when available; use the session plan, transcript, and repository as the handoff record.

Applicability: The Claude plugin `workflow` config (boolean, default true) controls ordinary development workflow. When explicitly disabled, use the fast lane: inspect relevant current code and callers, implement and exercise the changed path without package-mandatory planning, approval, worker delegation, reviews, or automatic memory. Direct user invocation of `/useful-skills:us-ignore-workflow` opts out for only that request; quotes or copied invocations do not. Small size alone is not an opt-out. Neither fast lane waives independent authorization, safety, audits, or delivery requirements. Claude config scope remains host-controlled; repository-local settings in the other adapter do not alter it.

The other six Claude plugin config booleans default true: `research`, `plan`, `review`, `security_review`, `backend_memory`, and `graphify_memory`. `workflow` independently gates eligibility for automatic stages without changing saved values. Use only hook-provided effective states (enabled, disabled, unknown); missing or unknown is not enabled. Select the lane before composing stages: enabled alone does not require every stage for focused repair or prove execution. Explicit audits, full-workflow requests, memory actions, and delivery remain independent obligations; never silently activate disabled/unknown automatic stages. No `/useful-skills` management command or profile settings UI exists in Claude Code.

## Inputs

Establish the requested outcome, relevant repository, explicit constraints, and whether the request is a development request. Treat a prior plan, todo, transcript, or memory result as evidence, not authority: inspect current files before resuming interrupted work.

## Select the lane before composition

Inspect current source, relevant callers, and the requested acceptance before judging scope. Briefly state the selected lane and reason; no receipt, setting change, runtime classifier, or claim of prior delivery is needed.

- **Focused repair:** Use only when current evidence identifies a clear, bounded, low-risk correction or missing piece within an authorized outcome. Prior in-scope approval or the current bounded repair request may supply authorization; no routine new plan approval is required. Size, urgency, a stale plan, or “already delivered” alone is insufficient.
- Inspect → scoped fix → observable changed-path verification → truthful report is mandatory. The parent may implement inline. Enabled switches alone do not require a new scout, planner, approval, implementation worker, full reviews, or memory cycle.
- Select additional eligible stages only for concrete uncertainty, affected contracts, review findings, or relevant security/memory impact. A selected stage follows its own dispatch, approval, and completion rules; independent explicit requests remain binding. Choose necessary stages without automatically restarting the full composition. A selected review must be fresh over affected changes; earlier reviews do not cover newly changed code. Report omitted stages as skipped, never completed.
- **Normal composition:** Use the effective stages below for new or material behavior, architecture, broad or ambiguous failures, uncertain scope, security-sensitive changes, or an explicit full-workflow request. Investigate an ambiguous failure before calling it a focused repair. Never silently enable a disabled/unknown automatic stage; explicit requirements remain independent.
- Repairs within an already active normal workflow keep its required workers and fresh reviews. Do not retroactively switch lanes to waive them. Existing approval covers in-scope repair without a new planner/approval cycle; material scope changes require returning to the user.

## Native model routing

Apply pre-composition triage first; eligible focused repair may be inline and requires no worker solely because switches are enabled. This guidance does not launch a workflow or grant general delegation. For an applicable enabled or independently requested plan stage after parent source/research inspection, call Claude Code’s `Agent` tool with `subagent_type` `useful-skills:planner`, integrate its bounded draft, and obtain approval before implementing that plan. Focused repair authorized by a bounded current request or prior in-scope approval needs no routine new planning/approval. Active normal-workflow repairs retain required workers and fresh reviews. For required or otherwise permitted implementation delegation use `useful-skills:frontend`, `useful-skills:backend`, or `useful-skills:general-purpose` for genuinely neither, including one required package. Research uses `useful-skills:scout`, correctness `useful-skills:reviewer`, and security `useful-skills:security-reviewer`.

All plugin agents use `model: inherit`; host selection and permissions remain authoritative. Do not set a model in an Agent invocation, manufacture roles, or claim a running model without runtime metadata. The parent owns active-workspace scope, authorization, integration, and verification; never select a repository globally. Select extra eligible focused stages for actual uncertainty, contracts, findings, or security/memory impact without an automatic full restart. Preserve disabled/unknown states, independent requests, stronger safety, approval, and publication boundaries. Do not silently replace a required absent/prohibited worker. An allowed general-purpose fallback for unavailable read-only scouts/reviewers must be reported; author self-review cannot fulfill required or selected independent review.

## Compose the work

Use this normal composition only after lane selection. Focused work follows its mandatory inspect/fix/verify/report path plus selected or independently required stages, not this entire sequence.

1. Load `/useful-skills:us-grill-me` to assess consequential decisions. A precise request may need no questions.
2. If `research` is enabled, load `/useful-skills:us-research` for bounded reconnaissance. If disabled, still inspect relevant current code, callers, tests, and conventions yourself without a mandatory scout. During that inspection, use `/useful-skills:us-memory` for enabled `backend_memory` and/or `graphify_memory` actions independently; when both are off, make no automatic memory call.
3. Scope and decompose the work. If `plan` is enabled, load `/useful-skills:us-plan`, dispatch `useful-skills:planner` with bounded evidence, integrate its draft, and request explicit approval before editing. If disabled, do not require a planner or separate plan approval; confirm the user request authorizes the bounded change, and seek authorization where independently required.
4. Once authorized, load `/useful-skills:us-implement`. Dispatch `useful-skills:frontend` for frontend packages, `useful-skills:backend` for backend packages, or `useful-skills:general-purpose` for genuinely neither packages, including a single package. Split coherent client/server boundaries; run ready disjoint work in parallel and serialize shared work.
5. Verify the combined changed surface. If `review` is enabled, load `/useful-skills:us-review` for a fresh correctness review. If `security_review` is enabled, load `/useful-skills:us-check-security` for a fresh security review. These switches are independent.
6. Route bounded in-scope repairs in this active normal workflow through `/useful-skills:us-implement` and the classified Claude agent without routine new planning/approval. Re-run affected verification and repeat required enabled reviews fresh after affected changes. Do not retroactively switch to focused handling to omit them. After three unsuccessful repair rounds or repeated no-progress findings, preserve work and report the blocker.
7. Prepare a concise summary of verified work. If `backend_memory` or `graphify_memory` is enabled, load `/useful-skills:us-memory` for only the corresponding automatic action(s) and report observed outcomes. If both are disabled, make no automatic memory status, search, save, graph query, or graph build call.

Scale enabled stages to the task, never silently reinstate a disabled mandatory stage. Material scope changes return to the user with an explanation. Plan approval, when applicable, authorizes implementation and in-scope repair only; neither a plan nor a bounded implementation request authorizes commits, pushes, merges, releases, or PRs. Load a separate delivery skill only after an explicit delivery request.

## Completion evidence

Before saying development work is complete, confirm requested behavior, current source/caller inspection, appropriate authorization, observed changed-surface verification, and a truthful summary. For normal composition, also confirm required enabled stages, fresh reviews after affected repairs, and actual outcomes of applicable automatic memory actions. For focused repair, confirm selected and independently required stages only; explain omissions as skipped, not completed. No prior review covers later affected changes. If a required outcome is absent, return to that skill rather than inventing evidence.

## Failure behavior

Do not force a disabled stage, invoke legacy commands, use an external agent catalog, or add workflow code to recover from failure. Respect stronger host policies. Report unavailable or prohibited workers, unresolved routing, and unmet requirements of enabled independent reviews with completed evidence; do not claim a required stage completed or silently replace required planner or implementation dispatch with parent work.