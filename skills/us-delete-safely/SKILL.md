---
name: us-delete-safely
description: Guides deleting files and folders without risking the filesystem root, the home folder, the workspace, its parent folders, or another Git repository, and tells when to delete freely and when to ask first. Use before any recursive delete or cleanup, such as removing build output, node_modules, caches, temp files, or running git clean or find -delete.
---

# Deleting files safely

Load `skill://us-write-concisely` before asking the user. A recursive delete cannot be undone, so decide what to remove before running anything.

## Never delete

- The filesystem or a drive root, and top-level system folders.
- The home folder or any folder above it.
- The workspace root or any folder above it.
- Any folder that contains `.git` (another repository, a submodule, or `.git` itself).
- A glob that empties one of these (`~/*`, `*` in the workspace root, `"$DIR"/*`).

If such a delete seems needed, stop and ask the user to do it themselves.

## Delete without asking

- An untracked build or cache folder inside the workspace: `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.next`, `.nuxt`, `.cache`, `.turbo`, `__pycache__`, `.pytest_cache`, `.venv`, `tmp`, `.tmp`. First confirm `git ls-files -- <path>` prints nothing.
- Files and folders you created yourself in the system temp folder.
- A single file you created or were asked to remove (`rm file`, no `-r`).

## Ask first

Every other recursive delete: tracked files, source folders, folders outside the workspace, `git clean -fd` or `-fdx`, `find … -delete`, and anything whose target you cannot name exactly. Tell the user the exact paths and why they can go.

## How to delete

1. Name the narrowest literal path. Avoid globs, variables, `$(…)`, `.` and `..` as targets.
2. Expand a glob first (`ls`, `find <path> -print`) and delete the listed paths.
3. Preview when you can: `git clean -n`, `find <path> -print`, `Remove-Item -WhatIf`.
4. Check symlinks with `realpath <path>`; never delete through a link that points outside the workspace.
5. Run the delete as its own command, not inside `sh -c`, `xargs`, a script, or interpreter code, and not after `mv`, `cp`, or `ln` in the same command.

If the host asks for permission or blocks a delete, do not retry it in another form. Report the target and wait for the user's decision.
