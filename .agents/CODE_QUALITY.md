# Code quality

Read these rules before adding or changing code in this repository. Apply them with the repository's contribution guidance, architecture, and language conventions. These are engineering constraints, not permission for unrelated refactors.

## File size and cohesion

- Keep authored source and test files at or below **500 physical lines**, including blank lines and comments. Measure the whole file, not only executable lines.
- Split oversized files along cohesive responsibilities and dependency boundaries. Preserve readable formatting; do not remove useful comments or compress statements merely to pass the limit.
- Generated, vendored, lock, data, and snapshot files are not hand-refactoring targets. Identify them explicitly when reporting exceptions. Do not silently exempt authored code. Record any approved exception with its reason and follow-up scope.

## Duplication

- Avoid duplicated business rules, validation logic, algorithms, and configuration that must change together. Keep each invariant in one authoritative place.
- Reuse existing helpers before creating a parallel implementation. Extract a shared abstraction only when the behavior is genuinely shared and the dependency direction remains sound.
- Similar-looking code with different reasons to change is not automatically duplication. Avoid a generic abstraction that couples unrelated features or obscures simple logic.

## Separation of concerns

- Give each module, class, and function a cohesive responsibility and an explicit contract. Keep UI/presentation, application orchestration, domain rules, persistence, and external integrations separate where those concerns exist.
- Keep I/O and side effects at clear boundaries. Make business decisions independently testable without requiring a browser, network service, or database where practical.
- Respect established dependency direction. Avoid circular dependencies, shared mutable global state, hidden initialization work, and modules that know too much about unrelated features.

## Object-oriented design where justified

- Use classes and interfaces when they clarify ownership, protect state invariants, model a lifecycle, or support real interchangeable behavior.
- Prefer composition over inheritance. Keep state encapsulated, public APIs small, and dependencies explicit.
- Prefer functions and plain data for stateless transformations. Do not add classes, factories, inheritance hierarchies, or design patterns solely to appear object-oriented.
- Follow the language's idioms and the existing architecture. SOLID principles are tools for diagnosing coupling and change risk, not a requirement to create an interface for every function.

## Readability and contracts

- Use precise names, straightforward control flow, and small focused functions. Document non-obvious invariants and tradeoffs rather than narrating the code.
- Validate external inputs at trust boundaries; represent failure explicitly. Do not hide failures with broad catches, silent no-ops, or fabricated fallback data.
- Keep exported APIs intentional. When a contract changes, migrate all callers and remove obsolete paths rather than keeping unnecessary compatibility layers.
- Avoid unnecessary allocation, copying, computation, and dependencies, but do not trade clarity for unmeasured micro-optimizations.

## Verification and review

- Run the repository's relevant checks and exercise changed behavior. Keep regression tests for plausible bugs, boundary cases, and meaningful invariants; do not test source text or incidental wiring.
- Review the diff for unrelated changes, dead code, secrets, duplicated logic, broken boundaries, and newly oversized files.
- Report concrete findings with file/line or symbol references, impact, and a focused remedy. Distinguish confirmed problems from suggestions and approved exceptions.
- Never claim checks passed when they were not run. Preserve user-owned changes and existing project-specific guidance.
