---
name: us-research
description: Use before changing code when current code, callers, tests, or conventions must be understood first, e.g. "investigate before we change it", "find where X is wired up", or when the research stage applies in the workflow. Read-only; uses a scout when required. Not for plain explanations of existing code.
---

# Evidence before implementation planning

Load `/harness-useful-skills:us-write-concisely`. Apply lane selection in `/harness-useful-skills:us-run-workflow` before composing automatic stages, including on direct loading. Research is read-only reconnaissance, not code, a plan, or approval. An eligible focused repair still requires current source/caller inspection but no automatic scout or full research cycle merely because `research` is enabled. Select this stage for concrete uncertainty or an independent request. Disabled/unknown research is not automatically selected; essential inspection remains the parent's duty.

## Inputs

Start with the requested behavior, known constraints, the current checkout, and any existing plan/todo/transcript that may describe prior work. Recheck important historical claims against current source.

## Procedure

1. Perform a bounded initial scope read: locate the likely implementation, callers, tests, configuration, project guidance, and relevant documentation. Follow actual data/control flow rather than isolated snippets.
2. When memory actions are applicable in normal composition or selected for concrete focused-repair memory impact, load `/harness-useful-skills:us-manage-memory` and follow only the corresponding eligible **During research** actions. Enabled memory settings alone do not force focused memory calls. If neither action is eligible/selected, make no automatic memory call (including `memory_status`); explicit memory requests remain independent. Unavailable memory does not block source inspection.
3. Before a required dispatch, read **Native model routing** in `/harness-useful-skills:us-run-workflow` without launching the whole workflow. Use only the active session workspace. Host permissions and approval boundaries remain authoritative.
4. After initial scope inspection, dispatch a read-only `harness-useful-skills:scout` through Claude Code’s `Agent` tool when research is applicable and enabled in normal composition, selected and eligible for focused repair, or a worker is independently required. Enabled research alone does not force focused scout dispatch. If unavailable and host policy permits, use `harness-useful-skills:general-purpose` with explicit read-only instructions and report the fallback. Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-research/references/scout-brief.md` and provide a filled brief with bounded evidence. The worker does not edit, plan, delegate, or launch a workflow.
5. Compare worker findings with source. Resolve disagreements by tracing current code. Identify existing reusable patterns, constraints, dependencies, affected interfaces, behavioral checks, and risks.

## Completion evidence

Return exact paths/symbols, caller/test relationships, conventions/docs, observed outcomes or skipped status for applicable memory actions, affected interfaces, verification candidates, and uncertainties. The brief informs a plan only when selected or applicable; it does not require one or imply approval. Do not call omitted stages completed.

## Failure behavior

A missing code graph, Claude facts backend, or worker does not block source research. Record the exact unavailable capability and complete all reachable source inspection. Do not invent worker findings or infer behavior from stale memory. When `code_map`, `code_symbol`, `code_impact`, and `code_path` are advertised, use them instead of grep for code-structure questions (routing in `/harness-useful-skills:us-manage-memory`); grep stays for literal text, error messages, config values, and unindexed files.