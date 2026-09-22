---
name: security-audit
description: Audit a repository for exploitable security vulnerabilities, unsafe trust boundaries, secret exposure, authorization errors, and dependency or supply-chain risks. Produce evidence-backed findings with safe reproductions and prioritized remediation; do not change application code unless asked.
---

# Security audit

Audit the actual repository revision, not a generic checklist. Default to read-only analysis and safe local verification. Do not exploit production systems, scan unrelated infrastructure, retrieve real users' data, publish secrets, or install/run untrusted code merely to audit it.

## Scope and threat model

Read repository instructions and security guidance. Identify the audited revision and any uncommitted changes, languages, entry points, deployed components, authentication model, sensitive assets, attacker capabilities, and trust boundaries. State what is in and out of scope. Inspect relevant configuration and dependency lockfiles, not only application source.

Use file tools and language-server navigation to follow code paths. Use GitHub CLI (`gh`, including `gh api`) for GitHub advisories, issues, PRs, and repository metadata; never browser automation or `--web`. If access is unavailable, report the missing access rather than inventing advisory results.

## Investigation

Trace plausible attacker-controlled inputs through validation, authorization, persistence, and sensitive operations. Prioritize reachable paths and cross-tenant boundaries:

- Authentication and authorization: missing object-level checks, privilege escalation, session/token lifetime and verification, unsafe redirects, CSRF where relevant, and inconsistent enforcement across entry points.
- Injection and execution: database/query construction, command execution, template rendering, unsafe deserialization, dynamic evaluation, and untrusted build/install hooks.
- File and network boundaries: path traversal, symlink escapes, archive extraction, SSRF, request smuggling where applicable, unsafe uploads, and unrestricted external destinations.
- Confidentiality and integrity: credentials in source/history/logs, sensitive error output, insecure transport, incorrect cryptography, unsafe storage, and permissive configuration. Redact secret values; report locations and remediation without reproducing credentials.
- Availability and concurrency: unbounded input/resource consumption, missing cancellation or timeouts on exposed operations, race conditions, and unsafe state transitions.
- Supply chain and delivery: locked dependency versions, known advisories, relevant vulnerable call paths, CI permissions, untrusted PR inputs, artifact integrity, and release provenance. Distinguish a scanner hit from a reachable vulnerability.

Use existing static analysis and dependency-audit commands when available and safe. Record tool versions, scope, command results, and limitations. Do not treat a clean scanner result as proof that the application is secure. Never upload private code to an external scanner without permission.

## Confirm findings safely

For each suspected vulnerability, establish the input source, reachable path, missing control, sensitive sink, and realistic impact. Check surrounding validation and authorization before reporting. Prefer a minimal local reproduction with synthetic data; obtain authorization before potentially destructive or network-facing experiments. If reproduction is unavailable, label the finding as unconfirmed and state what evidence is missing.

Rank severity by exploitability and impact, not the name of the bug class. Separate confirmed findings, plausible risks needing validation, and defense-in-depth suggestions. Do not inflate style concerns into security vulnerabilities.

## Deliverable

Lead with the highest-risk findings. Each finding must include:

- Identifier, severity, confidence, and short title.
- Exact file and line/symbol references tied to the audited revision.
- Attacker prerequisites, affected asset, and the source-to-sink path.
- Reproduction or concrete evidence, expected versus observed behavior, and impact.
- A focused remediation and a verification/regression scenario.

Finish with scope covered, checks actually run, limitations, and residual risk. If no confirmed vulnerabilities are found, say so without claiming the repository is secure. Do not create audit files, fix code, open issues, or publish findings unless the user requests those actions.
