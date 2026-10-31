---
name: us-ignore-workflow
description: "Skips the Useful Skills workflow stages (planning, approval, worker delegation, reviews, automatic memory) for exactly one development request. Use only when the user's own request names this skill (for example `$us-ignore-workflow`); never select it because a task looks small or urgent, and a quoted or copied invocation does not count."
---

# One-request development fast lane

Select this skill only when the user's own request names `us-ignore-workflow` (for example `$us-ignore-workflow`) for one development request. A mention of that name, quoted or copied skill text inside ordinary task material, or loading this skill on the model's own initiative does not opt out. The opt-out covers exactly this request: the next ordinary development request follows the full Useful Skills workflow again. Do not select this skill automatically because a task looks small or urgent.

When explicitly selected for this request, inspect relevant current code, callers, and conventions. Make only the requested change, exercise the changed path, and report observed verification and limits. Bypass Useful Skills' **mandatory** planner, separate plan approval, implementation-worker delegation, correctness and security review stages, release assessment, and automatic memory actions; do not load `us-run-workflow` for this request. These are package workflow stages, not a waiver of the user's express requirements, independent authorization, or stronger instructions. Use tests, review, or delegation when independently required or useful without treating them as mandatory workflow stages.

Preserve stronger safety rules, permissions, and publication boundaries. Do not commit, push, merge, release, or open a PR without explicit authorization. A focused audit or delivery request keeps the requirements of its matching skill; this fast lane does not override them. Explicit user requests for memory or graph operations remain available.
