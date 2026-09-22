---
name: us-research
description: Use automatically before planning any software implementation, including an apparently small fix or change. Inspect current code, callers, tests, conventions, documentation, and relevant memory, then produce grounded constraints and uncertainty.
---

# Evidence before implementation planning

Load `skill://us-concise`. Research is read-only reconnaissance. It produces evidence and constraints, not code, a plan, or approval.

## Inputs

Start with the requested behavior, known constraints, the current checkout, and any existing plan/todo/transcript that may describe prior work. Recheck important historical claims against current source.

## Procedure

1. Perform a bounded initial scope read: locate the likely implementation, callers, tests, configuration, project guidance, and relevant documentation. Follow actual data/control flow rather than isolated snippets.
2. Load `skill://us-memory` automatically and follow its **During research** procedure before dispatching a worker. Pass only bounded relevant evidence onward. Its strict plan/read-only restrictions remain authoritative; unavailable memory does not block source inspection.
3. Dispatch one read-only reconnaissance worker after the initial scope read. Use native `scout` only if advertised; otherwise use the advertised general-purpose worker. Give it `skill://us-research/references/scout-brief.md`, bounded retrieved evidence, and the request. The worker reports implementations/callers, conventions, evidence, and uncertainty; it does not edit, plan, or launch a workflow.
4. Compare worker findings with source. Resolve disagreements by tracing current code. Identify existing reusable patterns, constraints, dependencies, affected interfaces, behavioral checks, and risks.

## Completion evidence

Return an evidence brief with exact paths and symbols, caller and test relationships, relevant conventions/docs, memory result or limitation, likely affected interfaces, verification candidates, and open uncertainties. This brief is the input to `skill://us-plan`, not an implied approval.

## Failure behavior

A missing graph, native memory backend, or worker does not block source research. Record the exact unavailable capability and complete all reachable source inspection. Do not invent worker findings or infer behavior from stale memory. Dependency/cache writes, when permitted, belong only to the explicit actions described in `skill://us-memory`.