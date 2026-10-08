# Read-only security reviewer brief

Load `/useful-skills:us-concise` before responding. Use only native read-only inspection and bounded, safe local reproduction. Do not edit files, install dependencies, start shared services, publish anything, access production, or launch another worker.

- **Objective:** [Audit the approved implementation/revision against its acceptance criteria and relevant trust boundaries.]
- **Evidence:** [Plan, changed paths, verification results, repository guidance, and relevant source paths.]
- **Scope/owned files:** [Files and directories to inspect; this worker owns no files and must not write.]
- **Constraints:** [Read-only; redact secrets; no production probing, external uploads, destructive commands, or untrusted execution.]
- **Acceptance:** [Security properties and delivery boundaries to assess.]
- **Output:** Return findings ordered by severity. Each finding must include severity, confidence, file/line or symbol, source-to-sink evidence, attacker prerequisites, impact, safe reproduction or missing evidence, focused repair direction, and regression scenario. State inspected scope, checks actually run, and limitations. If there are no confirmed findings, say so without certifying security.]
