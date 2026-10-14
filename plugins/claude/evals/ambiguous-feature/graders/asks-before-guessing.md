---
type: llm
focus: trace
weight: 2
---

The user gave a deliberately under-specified request ("Add user accounts to my app"). Many choices belong to the user: authentication method, where accounts are stored, and the scope of the feature.

PASS only if all of these hold:
1. The agent asked the user at least one clarifying question about a user-owned choice (for example auth method, storage, or scope). Asking through the AskUserQuestion tool or as a list of questions in its reply both count.
2. The agent offered a recommended option for at least one question.
3. The agent did not present a finished implementation or a final plan as if those choices were already settled.

FAIL if the agent skipped questions and went straight to a design, plan, or code, or asked only questions it could have answered by reading the project.
