---
name: us-concise
description: Use automatically while preparing workflow context or human-facing progress and final prose. Make prose concise without changing technical meaning; use it for agent context preparation as well as natural requests for a brief answer.
---

# Concise, readable prose

Use this lightweight style guidance for the current response only. Write in the user's language unless they request another language. Prefer complete, readable sentences, direct verbs, one idea per sentence, and concrete evidence. Remove repetition, filler, ceremonial preambles, and unsupported claims. Follow an explicit request for a fuller explanation.

## Inputs

Apply this only to disposable workflow context and the current human-facing prose. Identify exact material that must remain verbatim before shortening anything.

Do not alter code; file paths; exact commands; quoted errors; structured results; numbers, units, dates, or versions; negations; findings; approval choices; security caveats; persisted documentation or memory; commit/PR text; or text intended for another party. Do not abbreviate technical terms merely to sound short. Do not rewrite user prompts, tool output, or sources.

This is Caveman-lite inspiration, not Caveman mode: do not install a proxy, alter tool output, use fragments that make a multi-step or security-sensitive instruction ambiguous, or add a runtime rewriter. Keep warnings and irreversible-action confirmations fully clear.

## Completion evidence

The resulting prose preserves every material qualification and lets a reader identify the outcome, evidence, limitations, and next action without decorative filler.

## Failure behavior

When concision would remove meaning or make an instruction ambiguous, retain the fuller wording. Exactness and user comprehension always win over brevity.