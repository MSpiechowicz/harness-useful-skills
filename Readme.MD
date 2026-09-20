<div align="center">

# Useful Skills for Oh My Pi

**Focused development workflows. One marketplace installation. Versioned updates.**

[![CI and Release](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/actions/workflows/release.yml/badge.svg)](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/MSpiechowicz/oh-my-pi-useful-skills)](https://github.com/MSpiechowicz/oh-my-pi-useful-skills/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

[Installation](#installation) · [Resource pack](#included-resource-pack) · [Commands](#commands) · [Updates](#updates) · [Development](#development)

</div>

---

Useful Skills is an [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin that combines the original practical development workflows with the reusable resource catalog from [Everything Claude Code (ECC)](https://github.com/affaan-m/ECC). The port is OMP-only: OMP discovers the skills, commands, agents, and rules, while the extension translates ECC lifecycle behavior to native OMP events.

The pack includes the original backlog, delivery, security, performance, and code-quality workflows plus the ECC engineering, testing, research, language, frontend, operations, and agent workflows. It does not install or execute adapters, hooks, scripts, MCP configuration, or runtime support for another harness.
## Included resource pack

| Surface | Contents | OMP entry point |
| :--- | :--- | :--- |
| Useful Skills | Backlog delivery, approved-change delivery, security, performance, and code-quality workflows | `/skill:<name>` |
| ECC skills | The vendored ECC skill catalog and supporting references | `/skill:<name>` |
| ECC commands | Prompt workflows for planning, review, verification, research, and delivery | `/<command>` |
| ECC agents | Specialist role prompts for OMP `task` delegation | `/ecc list agents` |
| ECC rules | Common engineering rules plus OMP compatibility guidance | Loaded by the plugin and extension |

The catalog is discoverable from the installed files; it is not duplicated in a registry. Use `/ecc list skills [query]`, `/ecc list commands [query]`, `/ecc list agents [query]`, or `/ecc list rules [query]`.

Skills are instructions for the assistant, not background automation. Installing the plugin does not start an audit, edit a repository, push a branch, open a PR, or merge changes.

## Requirements

- A current OMP installation with native marketplace support and `omp plugin list --json`.
- Node.js **22 or newer** for the terminal launcher.
- Git and network access for marketplace installation and updates.
- An authenticated [GitHub CLI](https://cli.github.com/) for workflows that access GitHub. Run `gh auth status` to check access.
- An OMP-configured memory backend is optional; `/ecc-memory` reports when none is active.
- Python **3.10 or newer** only for developing or running the release automation—not for using the plugin.

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

Open `/ecc` for the OMP-native catalog and workflow menu:

```text
ECC for Oh My Pi
  List skills
  List commands
  List agents
  List rules
  Doctor
  Memory
  Update
  Help
```

| Command | Action |
| :--- | :--- |
| `/ecc` or `/useful-skills` | Open the menu |
| `/ecc list [skills\|commands\|agents\|rules] [query]` | Browse the installed catalog |
| `/ecc doctor` or `/ecc-doctor` | Inspect resource counts, rules, safety, and memory |
| `/ecc-memory status` | Show the configured OMP memory backend |
| `/ecc-memory search <query>` | Search native OMP memory |
| `/ecc-memory save <fact>` | Save a durable fact to native OMP memory |
| `/useful-skills update check` | Check the latest stable GitHub release |
| `/useful-skills update install` | Upgrade the active marketplace installation |
| `/useful-skills help` | Show command guidance |

The extension reinforces ECC's portable engineering rules in `before_agent_start`, blocks only high-confidence catastrophic shell inputs, and redacts common secret shapes from tool results. OMP's normal approval flow remains authoritative for other destructive operations.
### In a terminal

```bash
./useful-skills list
./useful-skills update check
./useful-skills update install
./useful-skills help
```

The updater protects source checkouts: `update install` must run from the **installed package's launcher**, or use `/useful-skills update install` inside OMP. To update a development checkout, use `git pull --ff-only`. Updating the checkout alone does not upgrade a separate marketplace installation.

Update and install commands inherit `OMP_PROFILE`; the terminal launcher also accepts `--profile NAME`. Project-scoped operations use the current working directory.

## Using the skills

When OMP skill commands are enabled:

```text
/skill:ship-backlog-item
/skill:approve-changes
/skill:security-audit
/skill:tdd-workflow
/skill:verification-loop
/skill:unified-memory
```

Find a focused workflow without memorizing the catalog:

```text
/ecc list skills security
/ecc list skills frontend
/ecc list commands review
/ecc list agents architect
```

Alternatively, ask the assistant to use a skill by name. The model can read it through `skill://<name>` and can resolve related files from that skill directory. ECC examples that mention another harness are guidance content only; translate their tool names to OMP's `read`, `grep`, `glob`, `edit`, `write`, `task`, `hub`, `todo`, `browser`, and `memory` surfaces.

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

Interactive startup schedules a quiet background check for the latest stable GitHub release. If the active marketplace installation is behind, OMP shows a warning with the installed and available versions and the command to install the update:

```text
/useful-skills update install
```

**Checks never install code automatically.** Startup lookup failures stay quiet; an explicit check reports errors. Installation remains an explicit user action.

An update refreshes only this marketplace, upgrades the active plugin in its existing scope, and checks the resulting installed version. Disabled, shadowed, ambiguous, mismatched, or source-checkout installations are not silently rewritten.

Restart OMP after an update to refresh the loaded extension and the full ECC resource catalog.

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

# Browse the OMP-native catalog without running OMP
./useful-skills list skills
./useful-skills list commands review
./useful-skills list agents architect
./useful-skills list rules testing

# Run behavior and release-transaction regressions
node --test
python -m unittest discover -s test -p 'test_*.py'

# Check the extension entrypoints
node --check extension.js
node --check ecc-runtime.js
```

Add a skill at `skills/<name>/SKILL.md` with explicit `name` and single-line `description` frontmatter. Add prompt commands under `commands/`, agent role prompts under `agents/`, and rules under `rules/`. The catalog commands discover these files automatically; no second registry is maintained. Keep supporting templates inside the corresponding skill directory and reference them through `skill://<name>/...`.

The canonical ECC source and MIT terms are recorded in [`NOTICE-ECC.txt`](NOTICE-ECC.txt). Read [the repository quality guidance](.agents/CODE_QUALITY.md) before contributing. Keep the marketplace and package versions synchronized; let release automation perform future version bumps.

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
