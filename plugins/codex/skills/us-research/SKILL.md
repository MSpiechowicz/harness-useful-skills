---
name: us-research
description: "Use before changing code when current code, callers, tests, or conventions must be understood first, e.g. \"investigate before we change it\", \"find where X is wired up\", or when the research stage applies in the workflow. Read-only; uses a scout when required. Not for plain explanations of existing code."
---

# Evidence before implementation planning

Load the `us-write-concisely` skill. Apply lane selection in the `us-run-workflow` skill before composing automatic stages, including on direct loading. Research is read-only reconnaissance, not code, a plan, or approval. An eligible focused repair still requires current source/caller inspection but no automatic scout or full research cycle merely because the research stage exists. Select this stage for concrete uncertainty or an independent request; essential inspection remains the parent's duty.

## Inputs

Start with the requested behavior, known constraints, the current checkout, and any existing plan/task list/transcript that may describe prior work. Recheck important historical claims against current source.

## Procedure

1. Perform a bounded initial scope read: locate the likely implementation, callers, tests, configuration, project guidance, and relevant documentation. Follow actual data/control flow rather than isolated snippets.
2. When memory actions are applicable in normal composition or selected for concrete focused-repair memory impact, load the `us-manage-memory` skill and follow only the corresponding eligible **During research** actions. The memory stages alone do not force focused memory calls. If neither action is eligible/selected, make no automatic memory call (including `memory_status`); explicit memory requests remain independent. Unavailable memory does not block source inspection.
3. Before a required dispatch, read **Native model routing** in the `us-run-workflow` skill without launching the whole workflow. Use only the active session workspace. Host permissions and approval boundaries remain authoritative.
4. After initial scope inspection, dispatch a read-only scout by calling the `spawn_agent` tool with `agent_type` `us-scout` when research is applicable in normal composition, selected and eligible for a focused repair, or a worker is independently required. The research stage alone does not force focused scout dispatch. Subagents inherit the session sandbox and approval policy, so a read-only role is enforced by instructions only: state in the `message` that the agent must not edit files, install dependencies, or publish anything. If `us-scout` is missing and host policy permits, use the built-in `explorer` agent type with the same brief and report the fallback. Read `references/scout-brief.md` in this skill's directory (the folder that contains this SKILL.md) and pass the filled brief with bounded evidence and the research question as the `message`. The worker reports source/callers, conventions, evidence, and uncertainty; it does not edit, plan, or launch a workflow.
5. Compare worker findings with source. Resolve disagreements by tracing current code. Identify existing reusable patterns, constraints, dependencies, affected interfaces, behavioral checks, and risks.

## Completion evidence

Return exact paths/symbols, caller/test relationships, conventions/docs, observed outcomes or skipped status for applicable memory actions, affected interfaces, verification candidates, and uncertainties. The brief informs a plan only when selected or applicable; it does not require one or imply approval. Do not call omitted stages completed.

## Failure behavior

A missing code graph, facts backend, or worker does not block source research. Record the exact unavailable capability and complete all reachable source inspection. Do not invent worker findings or infer behavior from stale memory. When `code_map`, `code_symbol`, `code_impact`, and `code_path` are advertised, use them instead of grep for code-structure questions (routing in the `us-manage-memory` skill); grep stays for literal text, error messages, config values, and unindexed files.