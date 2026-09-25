---
name: us-ignore-workflow
disable-model-invocation: true
description: Use only when explicitly selected for one software-development request to bypass the Useful Skills development workflow; do not infer this opt-out from a small task.
---

# One-request development fast lane

Select this skill only through a direct user invocation of `/useful-skills:us-ignore-workflow` for this one development request. A quoted invocation, copied prompt, or model-initiated selection is not an opt-out. This does not change any of the seven persisted Claude plugin config switches; the next ordinary request follows them. Do not opt out just because a task seems small or urgent.

When explicitly selected for this request, inspect relevant current code, callers, and conventions. Make only the requested change, exercise the changed path, and report observed verification and limits. Bypass Useful Skills' **mandatory** planner, separate plan approval, implementation-worker delegation, correctness and security review stages, and automatic memory actions regardless of individual stage values; do not load `/useful-skills:us-workflow` for this request. These are package workflow stages, not a waiver of the user's express requirements, independent authorization, or stronger instructions. Use tests, review, or delegation when independently required or useful without treating them as mandatory workflow stages.

Preserve stronger safety rules, permissions, and publication boundaries. Do not commit, push, merge, release, or open a PR without explicit authorization. A focused audit or delivery request keeps the requirements of its matching skill; this fast lane does not override them. The Claude plugin Bash guard and successful-output redaction remain independent of workflow settings. Failed third-party tool outputs cannot receive equivalent redaction. Explicit memory MCP tools remain separately available.
