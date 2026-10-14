---
name: us-check-performance
description: Measures representative performance and finds bottlenecks with a baseline before recommending any change; never rewrites code speculatively. Use only when the user explicitly asks to "audit performance", "profile this", "find what is slow", "why is this slow", or "benchmark X".
---

# Performance audit

Load `skill://us-write-concisely` before preparing context or findings. This skill is read-only by default and does not authorize application changes, production load, profiler installation, or infrastructure changes.

## Establish a baseline

1. Read repository guidance, architecture, existing benchmarks, operational targets, runtime/build mode, and the exact revision.
2. Identify the user-visible metric and workload that matters: latency, throughput, startup, responsiveness, memory, allocation, storage, network use, or cost. Use documented targets when available; otherwise state the bounded local workload assumptions rather than inventing an SLO.
3. Prefer existing benchmark/profiler tooling. Use synthetic or explicitly approved fixtures, warm up where needed, repeat measurements, and record environment, input sizes, samples, central tendency, variability, and cold/warm distinction. Bound time and resources; stop only processes you started.

## Investigate the real path

Trace actual entry points and callers before looking for generic optimizations. Examine costly algorithms, repeated work, allocations and retention, serialization, I/O and query patterns, concurrency/backpressure/cancellation, startup work, and caching correctness. A static smell without measurement is a hypothesis, not a bottleneck. Do not weaken behavior, safety checks, or error handling to improve a number.

## Report actionable evidence

For every finding, state the location/symbol, workload, measurement or profile evidence, likely cause, user-visible consequence, simplest behavior-preserving recommendation, tradeoffs, and reproducible validation scenario. Separate measured findings from hypotheses and state what would confirm the latter.

Include a baseline table with the actual environment, workload, results, and limitations. Do not promise a speedup without a controlled before/after comparison. If implementation is later authorized, use `skill://us-run-workflow` and repeat the same measurement after functional verification. Leave a permanent benchmark only when requested or when it protects a demonstrated regression.
