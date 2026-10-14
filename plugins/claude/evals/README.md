# Plugin evals

Eval suite for `claude plugin eval` against the `useful-skills` plugin (`plugins/claude`). It measures two things:

- **Trigger accuracy** (`trigger` tag): whether skill descriptions make Claude pick the right skill for a plain request (`us-review`, `us-open-pr`, `us-check-performance`, `us-check-security`, `us-write-concisely`) and avoid heavy workflow skills for a simple explanation.
- **Grill-me behavior** (`grill-me` tag): whether `us-grill-me` asks about user-owned choices before guessing on an ambiguous request, and stays out of the way for a precise one.

## Run

From the repo root:

```sh
claude plugin eval plugins/claude --runs 1 --no-publish --max-cost-usd 10
claude plugin eval plugins/claude --runs 1 --no-publish --max-cost-usd 10 --tag trigger
claude plugin eval plugins/claude --runs 1 --no-publish --max-cost-usd 10 --tag grill-me
```

Results are written to `plugins/claude/evals/results/` (gitignored). The run also writes type scaffolding to `plugins/claude/tsconfig.json` and `plugins/claude/.claude-plugin/types/`. Both are gitignored, but `node scripts/build-claude-plugin.js --check` reports them as extra, so delete them after running evals:

```sh
rm -r plugins/claude/tsconfig.json plugins/claude/.claude-plugin/types
```

## Notes

- Every case allows only `Read`, `Glob`, `Grep`, `Skill`, and `AskUserQuestion`, so a run cannot edit files, push, or open a real PR. Prompts are self-contained and need no fixtures.
- Skill graders use `arm: both`, so they are scored in the with-plugin and the no-plugin baseline arms. The baseline has no `us-*` skills and scores 0 on them by design; the gap is the plugin's effect.
- `llm` graders use a paid judge model with 2-of-3 votes.
