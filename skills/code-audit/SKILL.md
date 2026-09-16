---
name: code-audit
description: Audit code quality, authored files exceeding 500 lines, duplicated behavior, separation of concerns, coupling, and appropriate use of OOP. Create or update .agents/CODE_QUALITY.md in the audited repository with durable instructions for future LLM work, preserving project-specific guidance.
---

# Code audit

Evaluate maintainability against the actual architecture and language conventions. Identify concrete change risks, not personal formatting preferences. Auditing does not authorize application-code refactoring. This skill does authorize creating or updating the requested repository instruction file, `.agents/CODE_QUALITY.md`.

## 1. Scope the repository

Read repository instructions, contribution guidance, architecture, formatter/linter configuration, and any existing `.agents/CODE_QUALITY.md`. Resolve the repository root from the working directory; never confuse the installed skill directory with the audited repository. Identify authored source and test roots and separately identify generated, vendored, dependency, build, snapshot, lock, and data files.

Use file tools and language-server navigation. Use GitHub CLI (`gh` or `gh api`) for GitHub context, not browser automation or `--web`.

## 2. Audit quality boundaries

- **500-line limit:** count physical lines in authored source and test files, including comments and blanks and a final unterminated line. Report every file exceeding 500 lines in the declared audit scope, with its count and a cohesive proposed split. Exactly 500 lines complies. Do not hide oversized authored files in exclusions, or game the rule by minifying code and removing useful documentation.
- **Duplication:** trace repeated business rules, validation, algorithms, and configuration that must evolve together. Check for existing reusable implementations. Distinguish genuine shared behavior from superficially similar code that should remain independent; avoid speculative generic helpers.
- **Separation of concerns:** examine boundaries between presentation, orchestration, domain rules, persistence, and integrations. Identify mixed responsibilities, hidden side effects, circular dependencies, and inappropriate dependency direction. Do not require architectural layers that the project does not need.
- **OOP where needed:** assess whether classes encapsulate meaningful state, protect invariants, manage lifecycles, or provide real polymorphism. Prefer composition. Flag needless inheritance, god objects, and classes that only wrap stateless functions, but do not demand OOP in functional or procedural code where plain functions and data are clearer.
- **Readability and correctness support:** inspect naming, control flow, error handling, public contracts, dead code, testability, test value, and documentation of non-obvious invariants. Focus findings on concrete maintenance or defect risk.

Use existing lint, type, complexity, or duplication tooling when available. Do not install a new analyzer merely to produce a score. Read surrounding code before reporting an automated match. Record the full scope and any uninspected areas; do not extrapolate a sample into a repository-wide clean bill.

## 3. Persist LLM-readable quality instructions

Read the bundled template at `skill://code-audit/CODE_QUALITY.md` (or `CODE_QUALITY.md` relative to this skill's directory).

Create `<repository-root>/.agents/CODE_QUALITY.md` from that template when absent. This is a normal Markdown instruction file, not a symlink to the extension and not an audit findings dump. Include the explicit 500-line rule, duplication guidance, separation of concerns, appropriate OOP, and verification expectations. Add repository-specific source roots, exclusions, and validation commands only when established from the repository; do not insert placeholders or unverified commands.

If the file already exists, read and merge the relevant rules in place. Preserve custom sections, user edits, architecture decisions, and stricter compatible constraints. Do not append duplicate headings or overwrite it wholesale on repeated invocations. Resolve contradictory repository policy explicitly instead of silently weakening either rule; report an unresolved conflict for user decision while completing the rest of the audit.

Before writing, check whether `.agents` or the target is a symlink; do not write through a path escaping the repository. If the target is a directory, inaccessible, or otherwise unsafe, report the exact blocker rather than replacing user data. Verify the resulting file can be read and contains the agreed guidance.

LLMs do not universally auto-load arbitrary `.agents/*.md` files. If the repository already has an LLM entrypoint such as `AGENTS.md`, add a concise relative reference to `.agents/CODE_QUALITY.md` in its relevant guidance section unless one already exists. Preserve existing instructions. Do not create a second entrypoint without user direction; when none exists, explicitly tell the user and future sessions to read `.agents/CODE_QUALITY.md`.

## 4. Report findings and the written artifact

Prioritize actionable findings. Each finding includes file/line or symbol references, the violated boundary or rule, concrete impact, supporting evidence, and the smallest coherent remedy. Group occurrences of one shared problem without hiding affected files. Separate required fixes from optional improvements and approved exceptions.

Report all over-limit authored files and counts, duplication clusters, concern-boundary issues, and OOP findings. If a category has no findings, state the inspected scope rather than claiming universal compliance. Include commands actually run and unavailable checks.

Finish with the exact path of `.agents/CODE_QUALITY.md`, whether it was created or merged, and any entrypoint reference added. Never claim the artifact exists unless the write and readback succeeded. Do not modify application code, move files, or open a PR unless separately requested.
