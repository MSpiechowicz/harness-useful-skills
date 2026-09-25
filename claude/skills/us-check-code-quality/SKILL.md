---
name: us-check-code-quality
description: Audit a repository for maintainability risks such as authored files over 500 lines, duplicated behavior, poor boundaries, coupling, and inappropriate object-oriented design. Use when the user explicitly requests a code-quality audit; do not refactor application code without separate authorization.
---

# Code-quality audit

Load `/useful-skills:us-concise` before preparing context or findings. Audit actual architecture and language conventions, not personal formatting preferences. This audit does not authorize application-code refactoring.

## Inspect the repository

1. Read repository instructions, contribution guidance, architecture, language tooling, and any existing `.agents/CODE_QUALITY.md`. Resolve the repository root from the working directory, not from this installed skill.
2. Identify authored source/test roots separately from generated, vendored, dependency, build, snapshot, lock, and data files. Read surrounding code before reporting automated matches. Use existing lint, type, complexity, or duplication tools only when safe and available; do not install a new analyzer merely to produce a score.
3. Report every authored source or test file over 500 physical lines, including comments and blanks (exactly 500 complies), with a cohesive proposed split. Also inspect genuine duplicated rules, responsibility boundaries, dependency direction, hidden side effects, lifecycle/state ownership, error handling, public contracts, dead code, test value, and non-obvious invariants.

## Preserve durable guidance

Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-check-code-quality/CODE_QUALITY.md`. On explicit invocation, create or merge `<repository-root>/.agents/CODE_QUALITY.md` using its relevant guidance. Preserve user edits, project-specific architecture decisions, and stricter compatible rules; do not replace a file wholesale, duplicate headings, insert placeholders, or turn findings into instructions.

Before writing, check that `.agents` and the target are not symlinks escaping the repository. If the destination is unsafe, inaccessible, or a directory, report the exact blocker without replacing user data. If an established LLM entrypoint already exists, add one concise relative reference only when it lacks one; do not create a new entrypoint. Verify the written file by reading it back.

## Deliverable

Prioritize concrete maintenance or defect risk. Each finding includes a file/line or symbol, evidence, impact, and smallest coherent remedy. Group one shared problem without hiding affected files. Separate required fixes, optional suggestions, and approved exceptions; state inspected scope rather than claiming universal compliance. Report the quality-guidance path and whether it was created or merged. Do not edit application code, publish work, or open a PR unless separately authorized.
