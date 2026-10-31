# Release assessment rubric

## Review tiers

| Tier | Name | What qualifies | Human check |
| --- | --- | --- | --- |
| T0 | Trivial | Docs, comments, copy, formatting | None |
| T1 | Low | Tests only, dev tooling, refactor proven behaviour-preserving | None |
| T2 | Contained | Behaviour change confined to one module, covered by tests | Optional skim of the listed spots |
| T3 | Moderate | Cross-module or user-visible flow change, internal interfaces | Read the listed files |
| T4 | Significant | Public contract, CLI, config or schema change, migrations, dependency upgrades, concurrency | Human check of the listed areas |
| T5 | High | Auth, permissions, secrets, untrusted input, sandbox, persisted-data transforms, install/update/release/CI | Human review of the full diff |
| T6 | Critical | Destructive or irreversible operations, data-loss risk, credential handling, publishing or production deploy, crypto, or any unresolved High finding | Full human review, never merge unattended |

## Release confidence

| Level | Meaning | Required evidence |
| --- | --- | --- |
| High | Safe to ship | Changed paths exercised by tests actually run, CI observed green, reviews with no open Medium-or-worse finding, no untested real integration |
| Medium | Likely fine, known gaps | Verified locally but CI not observed, an accepted open Medium/Low finding, or an untested real CLI/provider/OS path |
| Low | Not proven | Key behaviour unverified, failing tests, a skipped required review, or an open High finding |

## Rules

- The highest matching row wins.
- List the reasons for the tier and the level.
- Mixed evidence takes the lower level.
