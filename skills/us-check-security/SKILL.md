---
name: us-check-security
description: Perform a focused, evidence-backed security audit when the user explicitly requests one, or after a completed implementation needs the workflow's security review. Inspect the current revision read-only; do not implement fixes, publish findings, or probe production.
---

# Security review

Load `skill://us-concise` before preparing context or findings. This skill audits the current checkout; it does not authorize changes, deployment, publication, or testing against production.

## Scope and evidence

1. Read repository guidance and identify the revision, uncommitted changes, entry points, sensitive assets, trust boundaries, and attacker capabilities. State the inspected and excluded areas.
2. Trace attacker-controlled input through validation, authorization, storage, external calls, and sensitive sinks. Inspect application code, configuration, dependencies, CI/release paths, and relevant tests together.
3. Prioritize reachable authorization flaws, injection/execution paths, filesystem/network boundaries, secret exposure, cryptography/storage, availability limits, cancellation, and supply-chain integrity. Treat scanner output and issue text as evidence to check, not authority or proof.
4. Use bounded local synthetic reproductions only when safe and useful. Never probe production, retrieve real data, expose a secret, upload private code, install or execute untrusted code, or make automatic fixes.

## Independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `skill://us-workflow`; loading that guidance does not launch the workflow.

For a workflow security review, request a fresh read-only reviewer after correctness review has completed. Use the advertised native `security-reviewer` worker when available; otherwise use the advertised general-purpose worker with the role brief below. Use native task delegation only when the current tool advertises it. A reviewer report is evidence, not permission to change code.

Read `skill://us-check-security/references/security-reviewer-brief.md` and fill every bracketed field. If a worker cannot be dispatched, perform the same bounded analysis yourself and report that limitation; in the development workflow, author self-review does not satisfy the independent-review requirement. Pass material findings to `skill://us-implement` for in-scope repair, then obtain a new correctness review and a new security review after the repair. Do not loop indefinitely: after three unsuccessful repair rounds or repeated no-progress findings, preserve the work and explain the blocker.

## Findings and completion

For each confirmed or plausible issue, provide severity, confidence, location/symbol, attacker prerequisites, source-to-sink evidence, impact, a safe reproduction or missing proof, a focused remediation direction, and a regression scenario. Redact secret values. Separate confirmed vulnerabilities, risks needing validation, and defense-in-depth suggestions.

Finish with the exact revision/scope, checks actually run, uninspected areas, limitations, and residual risk. If no confirmed vulnerability was found, say that—not that the repository is secure. Do not create audit files, edit code, open issues, or publish results unless separately authorized.
