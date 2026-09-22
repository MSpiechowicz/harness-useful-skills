---
name: performance-audit
description: Audit a repository for performance bottlenecks, unnecessary work or allocation, poor algorithmic complexity, I/O inefficiency, concurrency problems, and resource growth. Use representative measurements and profiling to prioritize improvements without changing behavior or performing speculative rewrites.
---

# Performance audit

Find consequential bottlenecks and explain their cost. Default to read-only analysis plus bounded, reversible local measurements. Do not optimize code, add dependencies, benchmark production, or change infrastructure without authorization.

## Establish a useful baseline

Read repository instructions, architecture, existing benchmarks, and operational targets. Identify the audited revision, uncommitted changes, runtime versions, build mode, platform, and representative workload. Determine which user-visible metric matters: latency, throughput, startup time, responsiveness, memory, allocation, storage, network usage, or cost.

Use existing targets when documented. Otherwise state workload assumptions and choose a bounded local scenario; do not invent an SLO or claim a synthetic workload represents production. Preserve user work and production data. Use synthetic or explicitly approved fixtures.

Use file tools, language-server navigation, existing profilers, and the repository's benchmark tooling. For GitHub context use GitHub CLI (`gh` or `gh api`), not a browser or `--web`.

## Locate and measure expensive paths

Start with the real execution path and its callers rather than scanning for fashionable optimizations. Investigate as applicable:

- Algorithms and data structures: scaling with input size, repeated traversal, nested work, inefficient lookups/sorts, and avoidable recomputation.
- Allocation and memory: unnecessary copies, serialization, object churn, large retained graphs, cache growth, leaks, and lifecycle cleanup.
- I/O and data access: N+1 requests/queries, missing batching, excessive payloads, redundant reads/writes, database query plans and indexes, and blocking calls on interactive paths.
- Concurrency: serialized independent operations, lock contention, queue buildup, unbounded parallelism, missing backpressure, starvation, and cancellation that does not stop work.
- Startup and build/runtime costs: eager work, repeated initialization, expensive imports, unnecessary hydration or rendering, and avoidable background activity.
- Caching: demonstrated repeated work, hit rate, invalidation correctness, bounded size, and stale-data risks. A cache is not automatically the right fix.

Profile before making causal claims. Measure representative input sizes, include warmup where needed, repeat runs, and distinguish cold from warm behavior. Record sample count, central tendency and variability; report tail percentiles only with enough samples. Distinguish CPU time from wall time and peak memory from retained memory. Keep environment and workload consistent for comparisons.

Bound duration and resource use. Stop only processes you started. Do not disable safety checks, swallow errors, change semantics, or use unrealistic benchmark fixtures to make numbers look better. A code smell without measurement is a hypothesis, not a measured bottleneck.

## Analyze tradeoffs

For each candidate, identify the costly operation, triggering workload, scaling behavior, observed evidence, and user-visible consequence. Separate measured findings from static-analysis hypotheses and list what would confirm the latter.

Propose the simplest behavior-preserving change. Explain CPU/memory/latency tradeoffs, concurrency and ordering risks, cache invalidation obligations, and the verification workload. Do not promise a speedup without a controlled comparison. Prefer removing unnecessary work over adding a framework, cache, or abstraction.

## Deliverable

Prioritize by demonstrated impact and confidence. Each finding includes exact file/line or symbol, workload, measurement or profile evidence, likely cause, recommended change, tradeoffs, and a reproducible validation command/scenario.

Include a baseline table with environment, input sizes, runtime/build mode, actual results, and limitations. Report checks that could not run and why. If the user subsequently requests implementation, repeat the same measurements after the change and verify functional behavior; do not claim improvement from unrelated test timings. Leave permanent benchmark files only when requested or when they protect a demonstrated performance regression.
