---
description: A fully specified edit should be done directly, without grilling the user.
tags: [grill-me]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

Rename the variable `cnt` to `count` in this function and show me the updated code:

```js
function countEvens(numbers) {
  let cnt = 0;
  for (const n of numbers) {
    if (n % 2 === 0) cnt += 1;
  }
  return cnt;
}
```
