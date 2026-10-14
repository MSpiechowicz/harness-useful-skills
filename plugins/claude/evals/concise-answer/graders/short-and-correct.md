---
type: llm
focus: last_message
weight: 1
---

A mutex is a lock that one thread holds at a time and that only the holder releases (mutual exclusion). A semaphore is a counter that allows up to N concurrent holders and can be signaled by a different thread than the one that waited.

PASS only if the final answer is at most 5 sentences (a short list or table of equivalent size also counts) and is technically correct about this distinction. FAIL if it is longer, or states something incorrect, such as calling a mutex the same thing as a counting semaphore.
