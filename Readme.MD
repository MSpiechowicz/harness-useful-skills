<div align="center">

# Useful Skills for Oh My Pi

**Focused development workflows. One marketplace installation. Versioned updates.**

[![CI and Release](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/actions/workflows/release.yml/badge.svg)](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/MSpiechowicz/oh-my-pi-useful-skills)](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

[Installation](#installation) · [Skills](#included-skills) · [Commands](#commands) · [Updates](#updates) · [Development](#development)

</div>

---

Useful Skills is an [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that bundles practical, LLM-readable development workflows. Install it once through OMP's native marketplace; the extension and its skills are installed and upgraded together.

The collection covers taking an existing issue to a pull request, committing and merging approved changes, security reviews, performance investigations, and maintainability audits. Commands use OMP's native menus and notification styles rather than a separate terminal UI.

## Included skills

| Skill | Purpose | Delivery |
| :--- | :--- | :--- |
| [`ship-backlog-item`](skills/ship-backlog-item/SKILL.md) | Select an existing issue or backlog item, analyze it, create a branch, implement and verify the change | A focused pull request with verification evidence |
| [`approve-changes`](skills/approve-changes/SKILL.md) | Verify approved work, commit it, push its branch, and merge through a PR while respecting checks and reviews | A confirmed merge, or an exact delivery blocker |
| [`security-audit`](skills/security-audit/SKILL.md) | Trace trust boundaries, authorization, input handling, sensitive data, and supply-chain risks | Prioritized, evidence-backed findings and remediation |
| [`performance-audit`](skills/performance-audit/SKILL.md) | Investigate algorithmic cost, allocation, I/O, concurrency, and resource growth | Measured bottlenecks, reproducible workloads, and tradeoffs |
| [`code-audit`](skills/code-audit/SKILL.md) | Review file size, duplication, separation of concerns, coupling, and appropriate OOP | Actionable findings and repository-local quality instructions |

**GitHub work uses GitHub CLI.** The skills require `gh` or `gh api` for GitHub issues, project backlogs, comments, and PRs—not browser automation or `--web`. Local backlog files are read directly.

Skills are instructions for the assistant, not background automation. Installing the extension does not start an audit, edit a repository, push a branch, open a PR, or merge changes.

## Requirements

- A current OMP installation with native marketplace support and `omp plugin list --json`.
- Node.js **22 or newer** for the terminal launcher.
- Git and network access for marketplace installation and updates.
- An authenticated [GitHub CLI](https://cli.github.com/) for skills that access GitHub. Run `gh auth status` to check access.
- Python **3.10 or newer** only for developing or running the release automation—not for using the extension.

There are no npm dependencies to install.

## Installation

### From the marketplace

```bash
omp plugin marketplace add MSpiechowicz/oh-my-pi-useful-skills
omp plugin install oh-my-pi-useful-skills@omp-useful-skills --scope user
```

**Restart OMP after installation.** The extension and all bundled skills are discovered together; there is no separate skill-copying step.

For a project-only installation, run the second command from that project with `--scope project`. For a named profile, pass `--profile NAME` to both OMP commands:

```bash
omp --profile work plugin marketplace add MSpiechowicz/oh-my-pi-useful-skills
omp --profile work plugin install oh-my-pi-useful-skills@omp-useful-skills --scope user
```

### From a checkout

```bash
git clone https://github.com/MSpiechowicz/oh-my-pi-useful-skills.git
cd oh-my-pi-useful-skills
./useful-skills install
```

This registers the marketplace and installs its published plugin through OMP. It does **not** install the checkout as the managed plugin. Optional flags: `--scope user|project` and `--profile NAME`.

Marketplace installation requires a published release. Before the first release, preview the local package with `omp -e .` instead.

## Commands

### Inside OMP

Open `/useful-skills` for the native menu:

```text
Useful Skills
  List
  Update
    Check
    Install
  Help
```

Use arrow keys to navigate, Enter to select, Escape to cancel, and Left to return from the update submenu. The menu inherits OMP's active theme and uses its built-in info, warning, and error notifications.

| Command | Action |
| :--- | :--- |
| `/useful-skills` | Open the menu |
| `/useful-skills list` | List bundled skills and invocation commands |
| `/useful-skills update check` | Check the latest stable GitHub release |
| `/useful-skills update install` | Upgrade the active marketplace installation |
| `/useful-skills help` | Show command guidance |

### In a terminal

```bash
./useful-skills list
./useful-skills update check
./useful-skills update install
./useful-skills help
```

The updater protects source checkouts: `update install` must run from the **installed package's launcher**, or use `/useful-skills update install` inside OMP. To update a development checkout, use `git pull --ff-only`. Updating the checkout alone does not upgrade a separate marketplace installation.

Update and install commands inherit `OMP_PROFILE` or `PI_PROFILE`; the terminal launcher also accepts `--profile NAME`. Project-scoped operations use the current working directory.

## Using the skills

When OMP skill commands are enabled:

```text
/skill:ship-backlog-item
/skill:approve-changes
/skill:security-audit
/skill:performance-audit
/skill:code-audit
```

You can provide a focused request:

```text
/skill:ship-backlog-item Pick an unblocked bug from the existing backlog.
/skill:approve-changes Commit, push, and merge the changes we just approved.
/skill:security-audit Review authorization and file-upload boundaries.
/skill:performance-audit Investigate startup latency with a representative workload.
/skill:code-audit Audit the source and tests, and persist the quality rules.
```

Alternatively, ask the assistant to use a skill by name. The model can read it through `skill://ship-backlog-item`, `skill://approve-changes`, `skill://security-audit`, `skill://performance-audit`, or `skill://code-audit`.

### Ship backlog item

The workflow inspects existing issues or documented backlog sources, checks for duplicates and active work, selects one actionable item, and analyzes the code before editing. It creates an isolated branch, preserves unrelated changes, verifies the implementation, and uses `gh` to push the delivery through to a PR.

A ready-for-review PR requires completed implementation and relevant verification. The skill does not merge PRs, force-push, take over another contributor's work, or silently substitute a draft for an incomplete change.

### Approve changes

Invoke `/skill:approve-changes` to deliver approved work end to end: verify the scoped changes, commit them, push the delivery branch, create or reuse its PR, and merge into the intended base. A narrower request, such as commit-only, limits the workflow accordingly.

The skill preserves unrelated staged and unstaged work, checks outgoing commits and the full PR scope, and respects required CI, reviews, and branch protections. It does not force-push or bypass merge gates. Queued or auto-merge-pending work is reported as pending, not merged; completion requires GitHub confirmation.

### Audits and repository instructions

Security and performance audits default to read-only investigation and safe, bounded local verification. Findings distinguish observed evidence from hypotheses. Application changes, external publication, and production experiments require separate authorization.

The code audit also creates or merges:

```text
<repository-root>/.agents/CODE_QUALITY.md
```

Its [bundled template](skills/code-audit/CODE_QUALITY.md) covers:

- A **500-physical-line maximum** for authored source and test files.
- One authoritative implementation for shared business rules and invariants.
- Clear responsibility and dependency boundaries.
- Classes and interfaces where state, lifecycle, or polymorphism justify them; functions and data where they do not.
- Explicit contracts, readable code, and behavior-based verification.

Existing repository-specific guidance is preserved. Generated and vendored files are identified separately rather than refactored by hand. Repeated audits merge instructions instead of duplicating them.

If an existing `AGENTS.md` is present, the skill adds a relative reference when needed. Arbitrary `.agents/*.md` files are not universally auto-loaded by LLM tools; without an entrypoint, explicitly ask the assistant to read the file. This repository's own copy is at [`.agents/CODE_QUALITY.md`](.agents/CODE_QUALITY.md).

## Updates

Interactive startup schedules a background check for the latest stable GitHub release. If the active marketplace installation is behind, OMP shows a warning with the installed and available versions and the command to install the update:

```text
/useful-skills update install
```

**Checks never install code automatically.** Startup lookup failures stay quiet; an explicit check reports errors. Installation remains an explicit user action.

An update refreshes only this marketplace, upgrades the active plugin in its existing scope, and checks the resulting installed version. Disabled, shadowed, ambiguous, mismatched, or source-checkout installations are not silently rewritten. A user/project skill with the same name is never overwritten to force discovery.

Restart OMP after an update to refresh the loaded extension and skill metadata.

### Native recovery commands

```bash
omp plugin list --json
omp plugin marketplace update omp-useful-skills
omp plugin upgrade oh-my-pi-useful-skills@omp-useful-skills --scope user
```

Use the appropriate profile and `--scope project` when applicable. An enabled project installation takes precedence over the corresponding user installation.

## Release automation

[CI and Release](.github/workflows/release.yml) validates pull requests and pushes to `main`. After successful checks on `main`, GitHub Actions:

1. Resolves the next stable version from the tested package version and checks it against existing tags.
2. Updates `package.json`, the marketplace version, and its pinned `vMAJOR.MINOR.PATCH` source ref together.
3. Commits the metadata change and atomically pushes the branch and tag.
4. Publishes a GitHub Release with generated notes.

Normal pushes increment the patch version. Manual workflow runs can choose `patch`, `minor`, or `major`. A stale workflow cannot overwrite newer `main`; rerunning a partially published transaction reuses its matching tag instead of bumping again.

Release jobs have `contents: write`; validation jobs remain read-only. Repository branch and tag rules must permit the release bot's metadata commit and tag push. No release is published until this code is committed and pushed to GitHub and the workflow succeeds.

## Development

```bash
# Preview the package without installing a release
omp -e .

# List bundled skills without running OMP
./useful-skills list

# Run behavior and release-transaction regressions
node --test
python -m unittest discover -s test -p 'test_*.py'

# Check the extension entrypoint
node --check extension.js
```

Add a skill at `skills/<name>/SKILL.md` with explicit `name` and single-line `description` frontmatter. The list command discovers these files automatically; no second skill registry is maintained. Keep supporting templates inside the corresponding skill directory and reference them through `skill://<name>/...`.

Read [the repository quality guidance](.agents/CODE_QUALITY.md) before contributing. Keep the marketplace and package versions synchronized; let release automation perform version bumps.

## Troubleshooting

| Symptom | Check |
| :--- | :--- |
| `/useful-skills` is missing | Restart OMP, inspect `omp plugin list --json`, and check whether the extension is disabled |
| A skill is missing | Check skill enablement, include/ignore filters, and higher-precedence same-named skills |
| `/skill:…` is unavailable | Enable OMP skill commands or ask the assistant to read the `skill://…` resource |
| Update refuses a source checkout | Use the command inside the installed OMP extension; update development checkouts with Git |
| Native install or upgrade fails | Run the native recovery commands to inspect OMP's detailed error output |
| No release is available | Publish the first release through GitHub Actions; use `omp -e .` for local preview |
| GitHub-backed skill cannot inspect work | Check `gh auth status`, repository access, and any required GitHub Projects permissions |

## License

[GNU General Public License v3.0](LICENSE).
