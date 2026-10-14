---
name: us-grill-me
description: Asks the user one compact round of questions about behavior, interface, scope, data, cost, or delivery choices the code cannot answer, then stops until they reply. Use when a development request is ambiguous or underspecified, such as "add a feature", "build me X", or "make it better", or before planning any change where a user-owned choice would alter the result. Inspects the code first and never asks what the source already shows.
---

# Ask the user before guessing

Run this in the parent session before planning; a subagent cannot ask the user and reports open choices to its parent instead. Read the request and bounded, relevant repository facts first. Do not write files, change code, dispatch workers, or treat an answer as plan approval.

## Inputs

The stated objective, constraints, repository conventions, decisions already made, and anything still unknown.

## Method

1. Separate discoverable facts from user-owned choices. Answer the former from source and documentation; never ask the user what the repository shows.
2. A choice is user-owned when its answer would change behavior, interface, scope, data, cost, or delivery and neither the request nor the source settles it. Collect every such choice whose prerequisites are settled. When unsure whether a choice is the user's, treat it as theirs and ask.
3. Ask the frontier with one `AskUserQuestion` call: one question per choice (at most four; ask the rest next round), each with 2–4 options, the recommended option first with " (Recommended)" at the end of its label, and each option's effect on scope or users in its description. Then end your turn; do not plan, edit, or assume an answer while waiting. If `AskUserQuestion` is unavailable, ask the same questions as a numbered list and stop.
4. After each answer, look again: answers often open dependent choices (choosing OAuth raises which providers; choosing a cache raises its invalidation). Ask the new frontier the same way, one round at a time, until no user-owned choice remains. Record "I do not know" as an explicit assumption using the recommendation. Do not use questions to add scope.
5. Stop when the frontier is empty.

If no choice is user-owned, say so in one line naming the facts that made the request precise, and continue. A choice that needs a prototype or measurement becomes the smallest experiment in the plan, not a guess.

## Come back later

Return here whenever a later stage surfaces a new user-owned choice: research findings, open questions or risks in a planner draft, a review finding whose fix needs a product decision, or an implementation surprise that changes scope or behavior. Ask before presenting the plan or continuing the work; never bury the choice in the plan or decide it yourself.

## Completion evidence

A compact decision record: facts inspected, questions asked, answers, recommendations accepted or declined, and deferred experiments.

## Failure behavior

Never fabricate an answer or start implementation while a user-owned choice is open; if the user does not answer, keep it open as an explicit plan risk. Clarification is not plan approval; `/useful-skills:us-plan` requests that separately.
