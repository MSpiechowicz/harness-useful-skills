---
description: A plain explanation request must not trigger workflow, planning, implementation, grilling, or research skills.
tags: [trigger]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

Explain how this function works:

```js
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
```
