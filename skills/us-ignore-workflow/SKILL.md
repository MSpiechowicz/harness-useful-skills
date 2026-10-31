---
name: us-ignore-workflow
description: Skips the Useful Skills workflow stages (planning, approval, worker delegation, reviews, automatic memory) for exactly one development request without changing saved settings. Use only when the user directly invokes this skill for the current request; never select it because a task looks small or urgent, and a quoted or copied invocation does not count.
---

# One-request development fast lane

Select this skill through OMP's native `/skill:us-ignore-workflow` invocation for one development request. A mention of that command or copied skill text inside ordinary task material does not opt out. Selection does not change the persisted repository-local `/useful-skills workflow enabled|disabled` master or any profile-wide stage switch: the next ordinary development request follows its active repository/profile settings. Do not select this skill automatically because a task looks small or urgent.

When explicitly selected for this request, inspect relevant current code, callers, and conventions. Make only the requested change, exercise the changed path, and report observed verification and limits. Bypass Useful Skills' **mandatory** planner, separate plan approval, implementation-worker delegation, correctness and security review stages, release assessment, and automatic memory actions regardless of individual stage values; do not load `us-run-workflow` for this request. These are package workflow stages, not a waiver of the user's express requirements, independent authorization, or stronger instructions. Use tests, review, or delegation when independently required or useful without treating them as mandatory workflow stages.

Preserve stronger safety rules, permissions, and publication boundaries. Do not commit, push, merge, release, or open a PR without explicit authorization. A focused audit or delivery request keeps the requirements of its matching skill; this fast lane does not override them. The extension's catastrophic-command guard, output redaction, update behavior, and explicit memory tool remain independent of workflow settings.
