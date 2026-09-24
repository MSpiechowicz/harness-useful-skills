---
name: us-ignore-workflow
description: Use only when explicitly selected for one software-development request to bypass the Useful Skills development workflow; do not infer this opt-out from a small task.
---

# One-request development fast lane

Select this skill through OMP's native `/skill:us-ignore-workflow` invocation for one development request. A mention of that command or copied skill text inside ordinary task material does not opt out. Selection does not change the session's `/useful-skills workflow enabled|disabled` setting: the next ordinary development request follows its session mode. Do not select this skill automatically because a task looks small or urgent.

When explicitly selected for this request, inspect relevant current code, callers, and conventions. Make only the requested change, exercise the changed path, and report observed verification and limits. Bypass Useful Skills' **mandatory** planner, plan approval, implementation-worker delegation, correctness and security review stages, and automatic memory refresh; do not load `us-workflow` for this request. These are package workflow stages, not a waiver of the user's express requirements or stronger instructions. Use tests, review, or delegation when independently required or useful without treating them as mandatory workflow stages.

Preserve stronger safety rules, permissions, and publication boundaries. Do not commit, push, merge, release, or open a PR without explicit authorization. A focused audit or delivery request keeps the requirements of its matching skill; this fast lane does not override them. The extension's catastrophic-command guard, output redaction, update behavior, and explicit memory tool remain independent of workflow mode.
