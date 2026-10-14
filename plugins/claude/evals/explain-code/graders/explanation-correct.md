---
type: llm
focus: last_message
weight: 1
---

The function is a debounce: it returns a wrapper that, on each call, cancels the pending timer and schedules `fn` to run after `delay` ms, so `fn` only runs once calls stop for `delay` ms. It runs with the latest arguments and preserves `this`.

PASS if the explanation correctly conveys that repeated calls reset the timer and only the last call within the delay window triggers `fn`. FAIL if the explanation is wrong, misses the timer-reset behavior, or does not explain the function at all.
