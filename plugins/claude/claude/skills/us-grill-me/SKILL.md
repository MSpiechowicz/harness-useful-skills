---
name: us-grill-me
description: Use automatically during a software-development request when consequential product, behavior, scope, or delivery decisions remain unresolved. Inspect discoverable facts first and ask only questions the user must decide; a precise request needs no questions.
---

# Clarify the real decision frontier

Use this before planning, not as a substitute for source research. Read the request and bounded, relevant repository facts first. Do not write files, change code, dispatch workers, or treat a clarification response as plan approval.

## Inputs

Collect the stated objective, constraints, known repository conventions, decisions already made, and uncertainty that could materially change behavior, interface, security, cost, scope, or verification.

## Method

1. Separate discoverable facts from user-owned choices. Resolve the former through source and documentation inspection; do not ask the user to answer what the repository can show.
2. Build the current decision frontier: questions whose prerequisites are already settled. Ask the frontier in a compact round, not a slow drip of dependent questions.
3. For each consequential choice, state a recommendation, the principal alternative, and the effect on scope or users. Let the user reject, redirect, or answer “I do not know.”
4. Incorporate answers, then ask the next frontier only if a real consequential choice remains. Preserve the user's scope; do not use questions to smuggle in extra work.
5. Stop when the frontier is empty. Summarize settled decisions, assumptions that source evidence supports, and any deliberately deferred experiment.

Some questions are ungrillable without a prototype or measurement. Name that limitation and propose the smallest experiment for the later plan; do not guess a preference into a requirement.

## Completion evidence

Produce a compact decision record: facts inspected, questions asked (if any), user choices, recommendations declined or accepted, and unresolved experimental questions. If no question was needed, explicitly say which source-supported constraints made the request sufficiently precise.

## Failure behavior

When a required decision cannot be obtained, do not fabricate it or begin implementation. Carry it as an explicit plan risk or ask the user for the missing choice. Clarification is not the one implementation-plan approval; `/useful-skills:us-plan` requests that approval separately.