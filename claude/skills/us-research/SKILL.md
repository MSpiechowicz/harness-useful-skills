---
name: us-research
description: Use before implementation planning when the Claude plugin's research stage is enabled, or when explicitly requested. Inspect current code, callers, tests, conventions, documentation, and enabled memory evidence, then produce grounded constraints and uncertainty.
---

# Evidence before implementation planning

Load `/useful-skills:us-concise`. Research is read-only reconnaissance. It produces evidence and constraints, not code, a plan, or approval. When automatic `research` is disabled, essential inspection of current code, callers, tests, and conventions still belongs to the parent; this skill and its scout are not mandatory.

## Inputs

Start with the requested behavior, known constraints, the current checkout, and any existing plan/todo/transcript that may describe prior work. Recheck important historical claims against current source.

## Procedure

1. Perform a bounded initial scope read: locate the likely implementation, callers, tests, configuration, project guidance, and relevant documentation. Follow actual data/control flow rather than isolated snippets.
2. When automatic `backend_memory` or `graphify_memory` is enabled, load `/useful-skills:us-memory` and follow only the corresponding **During research** actions. If both are disabled, make no automatic memory call (including `memory_status`). Unavailable memory does not block source inspection.
3. Before a required dispatch, read **Native model routing** in `/useful-skills:us-workflow` without launching the whole workflow. Use only the active session workspace. Host permissions and approval boundaries remain authoritative.
4. After initial scope inspection, dispatch one read-only `useful-skills:scout` through Claude Code’s `Agent` tool when the automatic research stage is enabled or a worker is explicitly required. If that agent is unavailable, a permitted `useful-skills:general-purpose` fallback must receive explicit read-only instructions and be reported as a fallback. Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-research/references/scout-brief.md` and provide its filled brief and bounded evidence to the worker. It does not edit, plan, delegate, or launch a workflow.
5. Compare worker findings with source. Resolve disagreements by tracing current code. Identify existing reusable patterns, constraints, dependencies, affected interfaces, behavioral checks, and risks.

## Completion evidence

Return an evidence brief with exact paths and symbols, caller and test relationships, relevant conventions/docs, outcomes or skipped status for enabled/disabled memory actions, likely affected interfaces, verification candidates, and open uncertainties. This brief may inform `/useful-skills:us-plan` when enabled; it is not implied approval.

## Failure behavior

A missing graph, Claude facts backend, or worker does not block source research. Record the exact unavailable capability and complete all reachable source inspection. Do not invent worker findings or infer behavior from stale memory. Dependency/cache writes, when permitted, belong only to the explicit actions described in `/useful-skills:us-memory`.