---
name: us-assess-release
description: "Use after the final review and security review, before a PR or the workflow summary, or when asked to \"assess this release\", \"what tier is this PR\", \"how confident are we\". Fresh read-only assessment: review tier T0–T6, release confidence, and the files a human should check."
---

# Fresh release assessment

Load the `us-write-concisely` skill. Apply lane selection in the `us-run-workflow` skill when loaded directly. As a stage of an active workflow, keep that workflow's lane. This skill is read-only. It never edits, approves, or publishes, and never replaces correctness or security review. Explicit assessment requests remain binding.

## Inputs

Require the base ref and the exact head SHA (for uncommitted work, `HEAD` plus the working-tree and staged diff, recorded as `<SHA>+dirty`), the diff against the base, review and security findings with severity and disposition (fixed, accepted, or open), the verification commands actually run with their outcome, CI status only if observed, and the real integrations or paths that stayed untested. Inspect the current diff, not a previous assessment or an earlier summary. Missing evidence lowers confidence. Never fill it in from assumption.

## Request an independent assessment

Before running the child process, even when this skill is invoked directly, load the **Native model routing** guidance in the `us-run-workflow` skill. Loading that guidance does not launch the workflow.

Run the assessor as a fresh read-only child `pi` process with the `release-assessor` role, following **Native model routing** in the `us-run-workflow` skill. Read `references/assessor-brief.md` and `references/rubric.md` relative to this skill's base directory, and fill the brief. The script attaches the rubric, so do not paste it. The assessor must be fresh with respect to the implementation and inspect the actual diff: pass the pull request base to the script, also when uncommitted changes sit on top (`<SHA>+dirty`), and `HEAD` only when every change is uncommitted.

## Rules

- The highest matching tier wins. Any unresolved High finding makes the tier T6.
- Confidence comes only from observed evidence, never from implementer confidence. Without observed CI, confidence cannot be High. Mixed evidence takes the lower level.
- Tie the assessment to the exact head SHA or `<SHA>+dirty`. It is stale once the head or the working tree changes. A workflow assessment of uncommitted work is stale after the commit, so delivery re-runs it on the committed head.
- Classify and judge evidence only. Do not re-review for correctness or security.

## Output

Report the Review guide block:

1. One line: `Tier: T<n> <Name> · Confidence: <Level>`.
2. The matched tier row and the matched confidence row, quoted from the rubric.
3. Reasons: bullets with the evidence behind the tier and the confidence.
4. `Check`: the paths or areas a human should check, each with why. Write `none` for T0–T1.
5. When the tier is T4 or higher: `T4–T6 recommend a human check before merge`.
6. Both rubric tables inside `<details><summary>Tier and confidence definitions</summary>…</details>`.

In chat, report the same block. The tables may be omitted if you say they are defined in `references/rubric.md` relative to this skill's base directory.

## Completion evidence

Return the head SHA or `<SHA>+dirty`, assessor capability (`release-assessor` or fallback), the block above, and limitations. As a workflow stage, return to the `us-run-workflow` skill and continue its remaining stages (summary, memory). This assessment does not complete the workflow.

## Failure behavior

If the child process cannot run (non-zero exit or empty output), report that the assessment could not be made. Do not present author self-assessment as independent evidence or claim an assessment that was not made.
