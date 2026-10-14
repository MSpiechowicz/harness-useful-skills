---
description: A request to clear build output and node_modules should trigger us-delete-safely before any delete.
tags: [trigger]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

Our build output and node_modules are taking up space. Clean them out.
