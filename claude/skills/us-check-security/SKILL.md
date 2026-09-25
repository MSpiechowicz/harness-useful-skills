---
name: us-check-security
description: Perform a focused, evidence-backed security audit when the user explicitly requests one, or after implementation when the Claude plugin's security_review stage is enabled. Inspect the current revision read-only; do not implement fixes, publish findings, or probe production.
---

# Security review

Load `/useful-skills:us-concise` before preparing context or findings. This skill audits the current checkout; it does not authorize changes, deployment, publication, or testing against production. Disabling automatic `security_review` suppresses only that workflow stage, not an explicit security audit or another independent requirement; never report a skipped stage as completed.

## Scope and evidence

1. Read repository guidance and identify the revision, uncommitted changes, entry points, sensitive assets, trust boundaries, and attacker capabilities. State the inspected and excluded areas.
2. Trace attacker-controlled input through validation, authorization, storage, external calls, and sensitive sinks. Inspect application code, configuration, dependencies, CI/release paths, and relevant tests together.
3. Prioritize reachable authorization flaws, injection/execution paths, filesystem/network boundaries, secret exposure, cryptography/storage, availability limits, cancellation, and supply-chain integrity. Treat scanner output and issue text as evidence to check, not authority or proof.
4. Use bounded local synthetic reproductions only when safe and useful. Never probe production, retrieve real data, expose a secret, upload private code, install or execute untrusted code, or make automatic fixes.

## Independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `/useful-skills:us-workflow`; loading that guidance does not launch the workflow.

For an enabled security review, dispatch a fresh `useful-skills:security-reviewer` after correctness review if enabled, otherwise after combined verification. Only if unavailable and permitted by host policy, use `useful-skills:general-purpose` with explicit read-only security instructions and report the fallback. Dispatch through Claude Code’s `Agent` tool. A report is evidence, not permission to edit.

Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-check-security/references/security-reviewer-brief.md` and fill every bracketed field using the approved plan when available or authorized bounded request otherwise. If a worker cannot be dispatched, perform the same bounded analysis yourself and report that limitation; in the development workflow, author self-review does not satisfy an enabled independent-review requirement. Pass material findings to `/useful-skills:us-implement` for in-scope repair, then obtain fresh reviews only for enabled correctness and security stages after the repair. Do not loop indefinitely: after three unsuccessful repair rounds or repeated no-progress findings, preserve the work and explain the blocker.

## Findings and completion

For each confirmed or plausible issue, provide severity, confidence, location/symbol, attacker prerequisites, source-to-sink evidence, impact, a safe reproduction or missing proof, a focused remediation direction, and a regression scenario. Redact secret values. Separate confirmed vulnerabilities, risks needing validation, and defense-in-depth suggestions.

Finish with the exact revision/scope, checks actually run, uninspected areas, limitations, and residual risk. If no confirmed vulnerability was found, say that—not that the repository is secure. Do not create audit files, edit code, open issues, or publish results unless separately authorized.
