---
name: us-keep-ui-consistent
description: "Use when a change alters how a UI element looks or behaves (size, colour, spacing, variant, states, copy, interaction), or when asked to \"check UI consistency\" or \"make views consistent\". Finds every sibling instance across views, applies the same change, and reports each one. Skip for backend-only changes or a one-off element."
---

# Keep sibling UI consistent

Load the `us-write-concisely` skill before writing to the user. A changed element rarely lives in one view: its same-pattern siblings are part of the requested change, not scope creep. Do not drift into unrelated redesign. A sibling fix that needs an interface change or a different kind of work is material scope: report it and ask. So is a hit in another app or package, or a shared component or token that other apps or packages consume: show the instance table and ask once before editing it.

## Inputs

The change (diff or request), the element and property changed, the component library, design tokens and theme, the style system, the routes, views, and screens, and any documented variants or design-system docs.

## Method

Steps 1-4 are read-only; every edit happens in step 5.

1. State one line: element, property, before → after. If the element itself is ambiguous, ask before searching; when loaded for review, state the assumed element and report the ambiguity as a finding instead. On demand with no diff, the reference is the shared component or token default, else the dominant instance; if neither is clear, include it in the step 4 question.
2. Check ownership first. If a shared component, token, theme variable, or utility already owns the property, record it as the first fix hit (changing it there is the fix, not an extraction) and find local overrides that bypass it. If other apps or packages consume that owner, record it as held instead (see step 4).
3. Search the whole source tree, not just open files: the component name and its imports; classes, tokens, utility combinations, and selectors; the same literal values and copy-pasted markup or styles; copy patterns (labels, casing, punctuation); stories, snapshots, and visual tests. Cover every view, page, and screen, including dialogs, drawers, menus, and toasts, plus empty, loading, and error states, responsive breakpoints, and themes or dark mode.
4. Classify each hit. Same pattern: fix. Intentional variant: leave it and cite the evidence (variant prop, design docs, comment, distinct context). Unsure, in another app or package, or needing an interface change or a different kind of work: hold it; never guess. Inside a delegated work package, report held items to the parent instead of asking. When loaded for review, stop here without asking or editing: report the table with held items as findings. Otherwise, if anything is held, the reference is unclear, or the request is to check or audit, ask once via the `us-grill-me` skill with the instance table and the proposed target, then wait; confirmed items become fix hits, and declined or unanswered ones stay left. A request to make views consistent with nothing held continues without asking.
5. Apply the same change to every fix hit in this task, the shared owner first, following each site's local style. Update stories and snapshots only where they pin the changed property. Under the `us-implement` skill, finish steps 1-4 before dispatching so every fix site, including the owner, sits inside a package's owned files.
6. If copied styling caused drift and no shared owner exists, finish the fixes first, then propose an extraction (candidate name, sites covered, risk) as a separate follow-up. Never extract without approval.
7. Verify. Prefer the `browser` tool when present, against a local or preview environment only, viewing without submitting data: open the affected views at narrow and wide widths and in the relevant states, labelling states that need a submit as search-only. Otherwise run the project's visual or snapshot tests. Failing both, rerun the step 3 searches to show no same-pattern miss remains, and label the result search-only.
8. Report a table (path or view | fixed, left, asked, or reported | reason), then any extraction proposal.

## Completion evidence

The element and property line, the searches run (patterns and scope), the instance table, the views, widths, and states verified or the limitation (none in a review load), questions and answers, and any extraction proposal. Hand off to the `us-review` skill when applicable.

## Failure behavior

Never claim a view was checked that was not searched or viewed. Ask if the element is ambiguous; in a review load, report it instead. Name places not to edit (generated code, build output, vendored or third-party copies, CMS or server-driven markup, external design-system packages) and report them rather than edit. Add no dependencies, commits, or extractions without approval. Inside a delegated work package, report siblings outside owned files instead of editing them; the parent extends ownership for same-kind fixes in the same app or package.
