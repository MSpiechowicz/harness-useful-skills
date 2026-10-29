---
name: us-check-security
description: Use for "security audit", "security review", "check for vulnerabilities", "is this secure", or when the security review stage applies in the workflow. Read-only, evidence-backed audit (trust boundaries, injection, auth, secrets, unsafe input); never fixes code, publishes findings, or probes production.
---

# Security review

Load `/harness-useful-skills:us-write-concisely` before preparing context or findings. This skill audits the current checkout; it does not authorize changes, deployment, publication, or testing against production. Disabling automatic `security_review` suppresses only that workflow stage, not an explicit security audit or another independent requirement; never report a skipped stage as completed.

Apply pre-composition lane selection in `/harness-useful-skills:us-run-workflow` when loaded directly; as a stage of an active workflow, keep that workflow's lane and never switch it to omit stages. Enabled `security_review` alone does not require an automatic audit for a clear low-risk focused correction. Actual security-sensitive changes require normal applicable stages and any independent security obligations, never a size-based exemption. Disabled/unknown stages are not activated automatically. A selected focused audit remains independent and fresh after affected changes; it does not trigger unrelated full-workflow stages.

## Scope and evidence

1. Read repository guidance and identify the revision, uncommitted changes, entry points, sensitive assets, trust boundaries, and attacker capabilities. State the inspected and excluded areas.
2. Trace attacker-controlled input through validation, authorization, storage, external calls, and sensitive sinks. Inspect application code, configuration, dependencies, CI/release paths, and relevant tests together.
3. Prioritize reachable authorization flaws, injection/execution paths, filesystem/network boundaries, secret exposure, cryptography/storage, availability limits, cancellation, and supply-chain integrity. Treat scanner output and issue text as evidence to check, not authority or proof.
4. Use bounded local synthetic reproductions only when safe and useful. Never probe production, retrieve real data, expose a secret, upload private code, install or execute untrusted code, or make automatic fixes.

## Independent review

Before dispatching—even when this skill is invoked directly—load the **Native model routing** guidance in `/harness-useful-skills:us-run-workflow`; loading that guidance does not launch the workflow.

For an applicable enabled normal-workflow or selected eligible focused security review, dispatch a fresh `harness-useful-skills:security-reviewer` after required/selected correctness review, otherwise after changed-surface verification. Only if unavailable and host policy permits, use `harness-useful-skills:general-purpose` with explicit read-only security instructions and report the fallback. Use Claude Code’s `Agent` tool. A report is evidence, not permission to edit; selected reviews remain fresh after affected changes.

Read `${CLAUDE_PLUGIN_ROOT}/claude/skills/us-check-security/references/security-reviewer-brief.md` and fill every field from the applicable approved plan, prior in-scope approval, or authorized bounded request. If a worker cannot be dispatched, perform reachable bounded analysis and report that limitation; author self-review does not satisfy a required or selected independent workflow review. Pass material findings to `/harness-useful-skills:us-implement` for authorized repairs within the active lane, rerun affected verification, then obtain fresh required/selected correctness and security reviews over affected changes. Do not restart unrelated stages or seek routine re-approval within scope. Fix a simple finding (local, low-risk, obvious repair such as a typo, missing guard, wrong message, or small test gap) inline without a new worker, and scope its re-review to the repaired lines and the findings they answer, not the whole change. Report minor suggestions instead of looping on them. Cap each review stage at three passes—the first review plus at most two re-reviews—counted whether or not a pass finds something new. A High finding is never accepted: while any pass reports one, keep going past the cap—repair it, then run a fresh full-scope review of the whole change (not one scoped to the repaired lines)—until no High finding remains. Once the cap is reached and no High finding is open, start no further repair or review round, even for Medium or lower findings: preserve the work, report every unresolved finding with its severity, and let the user decide which to fix; never weaken acceptance or claim it met.

## Findings and completion

For each confirmed or plausible issue, provide severity, confidence, location/symbol, attacker prerequisites, source-to-sink evidence, impact, a safe reproduction or missing proof, a focused remediation direction, and a regression scenario. Redact secret values. Separate confirmed vulnerabilities, risks needing validation, and defense-in-depth suggestions.

Finish with the exact revision/scope, checks actually run, uninspected areas, limitations, and residual risk. If no confirmed vulnerability was found, say that—not that the repository is secure. Do not create audit files, edit code, open issues, or publish results from this skill unless separately authorized; in an active workflow, its existing approval or bounded request already covers in-scope repair through `/harness-useful-skills:us-implement`. As a workflow stage, return to `/harness-useful-skills:us-run-workflow` and continue its remaining stages (repairs, memory, summary); this audit does not complete the workflow.
