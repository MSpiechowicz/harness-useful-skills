---
type: llm
focus: trace
weight: 1
---

The user asked for one precise, fully specified change: rename `cnt` to `count` in the supplied function and show the updated code.

PASS if the agent produced the renamed function (every `cnt` replaced by `count`, behavior unchanged) without asking the user any clarifying question about requirements. FAIL if the agent asked the user a question (via AskUserQuestion or in its reply) before answering, or if the final code does not correctly apply the rename.
