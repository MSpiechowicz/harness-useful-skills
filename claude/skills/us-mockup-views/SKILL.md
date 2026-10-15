---
name: us-mockup-views
description: Use when a request changes how a view, page, screen, or layout looks or flows and several designs are plausible: "redesign this page", "new dashboard", "show me options", "mock it up", "let me pick". Builds 2-4 clickable HTML mockups, opens them in the browser, and lets the user choose instead of guessing. Skip for small tweaks with one obvious result.
---

# Show the options before building

Load `/useful-skills:us-write-concisely` before writing to the user. A big visual or interaction change has no single right answer, so build the candidates, show them, and let the user pick. Mockups are throwaway previews, not the implementation, and a pick is not plan approval.

## Inputs

The requested change, the affected views, the existing stack, design tokens, components and styles, real content and data shapes, and constraints already decided.

## Method

1. Inspect the current view and its styles first. Settle every question the source answers; if a user-owned choice remains that mockups cannot answer (data, scope, cost), load `/useful-skills:us-grill-me` and ask before building.
2. Choose 2-4 options that differ in structure or interaction, not in colour alone. Name each, say its tradeoff in one line, and mark one "(Recommended)".
3. Build each option as a self-contained static HTML file with inline CSS and JS, no build step and no network dependency. Reuse the project's tokens, fonts, and component look, and real or realistic content. Write the files to a scratch folder outside the source tree (for example the system temp directory), never into the repository's source, and add nothing to the project.
4. Make mockups interactive only where behaviour is the question: navigation, toggles, filters, modals, responsive breakpoints, empty/loading/error states. Fake the rest with static data.
5. Add one `index.html` that lays the options side by side or switches between them with labels, the tradeoff line, and a recommended badge. Keep each option also openable alone.
6. Open `index.html` in the browser. Prefer the `browser` tool when present: open the tab, exercise the interactions, check the narrow and wide widths, and look at the real rendering before showing it. Otherwise open the file with the system opener (`open`, `xdg-open`, `start`). Fix anything broken before the user sees it.
7. Report the file path, one line per option with its tradeoff and recommendation, and ask which to take, which parts to combine, or what to change. Use `AskUserQuestion` when available; then end your turn.
8. Iterate on feedback with a new round of mockups until the user picks. Record the chosen option, the parts of others to keep, and the rejected options with the reason.

## Completion evidence

The scratch path, the options shown with tradeoffs, interactions exercised, widths checked, the user's choice, and any assumption made. Hand the choice to `/useful-skills:us-plan` or `/useful-skills:us-implement`; the chosen mockup is the reference, not code to copy wholesale.

## Failure behavior

If no browser can be opened, give the file path and say so; never claim the mockups were viewed. If the stack or assets are unknown, build neutral mockups and label them so. Never edit source, add dependencies, commit, or leave scratch files in the repository. Remove the scratch folder only after the user is done with it, and apply `/useful-skills:us-delete-safely` first.
