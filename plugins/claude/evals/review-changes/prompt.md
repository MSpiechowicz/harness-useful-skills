---
description: A review request with an inline diff should trigger us-review, and the review should catch the off-by-one.
tags: [trigger]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

Review my changes and check this diff for bugs:

```diff
--- a/src/paginate.js
+++ b/src/paginate.js
@@ -1,8 +1,8 @@
 // page is 0-based; returns the items on that page
 function paginate(items, page, pageSize) {
   const start = page * pageSize;
-  return items.slice(start, start + pageSize);
+  return items.slice(start, start + pageSize - 1);
 }

 module.exports = { paginate };
```
