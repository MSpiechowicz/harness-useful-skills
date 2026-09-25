---
name: us-approve-work
description: Commit explicitly approved work and push it directly to the remote main branch only when the user explicitly requests that delivery. Preserve unrelated work and refuse ambiguous, divergent, protected, non-fast-forward, or contaminated direct-main pushes.
---

# Approve and push work to main

Load `/useful-skills:us-concise` before preparing delivery prose. An approved implementation plan, successful review, or reading this skill is not permission to commit or publish. Require an explicit user request to commit approved work and push it to `main`; honor a narrower commit-only request without pushing.

## Establish a safe delivery set

1. Read repository guidance and inspect the current branch, worktree, index, remotes, upstream, protected-branch policy if visible, and the commits that `HEAD:refs/heads/main` would publish. Fetch the intended remote's `main` ref without rewriting local work.
2. Resolve the approved files/hunks and existing approved commits from the conversation and actual diffs. Preserve unrelated staged/unstaged work, branches, and commits. Stage only approved files or hunks; inspect the entire staged diff immediately before committing. If already staged unrelated changes cannot be isolated without disturbing them, stop and report the isolation blocker.
3. Commit only approved uncommitted work using repository convention. Reuse already committed approved work rather than create an empty commit. Direct delivery is blocked if any outgoing commit is unrelated, the target/writable remote is absent or ambiguous, `main` is protected, the work cannot be verified/reviewed for the exact delivery head, or the expected destination is not clearly `main`. Never silently substitute a PR.

## Fast-forward-only direct push

Before pushing, verify the fetched remote `main` tip is an ancestor of the exact delivery `HEAD`; otherwise the direct push is non-fast-forward and must stop. Confirm that the expected remote `main` tip has not changed before the push. Push only with the explicit non-force refspec:

```text
git push <authorized-remote> HEAD:refs/heads/main
```

Never use `--force`, `--force-with-lease`, rebase, reset, clean, stash, amend a published commit, bypass branch protection, modify repository permissions, or switch to a PR to evade a block. A rejected push preserves the local commit and is an honest delivery failure, not authority to retry destructively.

After a successful push, obtain the remote `refs/heads/main` SHA and confirm it equals the delivery head SHA. Report the commit SHA, remote, destination, actual verification/review evidence, and observed remote tip. If any condition fails, state the exact blocker and recovery prerequisite; never claim the push succeeded.
