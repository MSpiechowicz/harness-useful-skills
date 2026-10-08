import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readClaudeWorkflow } from "../claude/settings.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { STAGES, writeWorkflowSetting } from "../workflow-settings.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-claude-settings-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = path.join(root, "claude");
  const repo = path.join(root, "repo");
  const otherRepo = path.join(root, "other-repo");
  for (const directory of [configDir, path.join(repo, ".git"), path.join(otherRepo, ".git")]) {
    await mkdir(directory, { recursive: true });
  }

  return {
    root, configDir, repo, otherRepo,
    stageDirectory: path.join(configDir, "useful-skills", "workflow-settings"),
    environment: (options = {}) => ({ CLAUDE_CONFIG_DIR: configDir, ...options }),
    save: (key, enabled, cwd = repo) => writeWorkflowSetting({ agentDir: configDir, cwd, key, enabled }),
  };
}

test("a saved file beats the plugin option; a missing file falls back to the option, then to enabled", async t => {
  const f = await fixture(t);

  const nothing = await readClaudeWorkflow({ environment: f.environment(), cwd: f.repo });
  assert.equal(effectiveWorkflow(nothing).workflow.effective, "enabled");
  assert.ok(["workflow", ...STAGES].every(key => nothing.sources[key] === "default"));
  assert.equal(nothing.scopeRoot, f.repo);

  const optionOff = await readClaudeWorkflow({
    environment: f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "false", CLAUDE_PLUGIN_OPTION_PLAN: "false" }),
    cwd: f.repo,
  });
  assert.equal(effectiveWorkflow(optionOff).workflow.effective, "disabled");
  assert.equal(optionOff.values.plan, false);
  assert.equal(optionOff.sources.workflow, "option");

  await f.save("workflow", false);
  await f.save("review", false);
  const saved = await readClaudeWorkflow({
    environment: f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "true", CLAUDE_PLUGIN_OPTION_REVIEW: "true" }),
    cwd: f.repo,
  });
  assert.equal(effectiveWorkflow(saved).workflow.effective, "disabled");
  assert.equal(saved.values.review, false);
  assert.equal(saved.sources.workflow, "file");
  assert.equal(saved.workflowFile.startsWith(path.join(f.stageDirectory, "repositories") + path.sep), true);

  await f.save("workflow", true);
  const savedOn = await readClaudeWorkflow({
    environment: f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "false" }),
    cwd: f.repo,
  });
  assert.equal(effectiveWorkflow(savedOn).workflow.effective, "enabled");
});

test("an invalid option with no saved file stays unknown", async t => {
  const f = await fixture(t);
  const invalid = await readClaudeWorkflow({ environment: f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "yes" }), cwd: f.repo });
  assert.equal(effectiveWorkflow(invalid).workflow.effective, "unknown");
  assert.match(invalid.errors.workflow, /Invalid Claude plugin boolean option/);
});

test("corrupt or symlinked saved files are unknown and never fall back to the option", async t => {
  const f = await fixture(t);
  await f.save("plan", false);
  await f.save("workflow", false);
  const saved = await readClaudeWorkflow({ environment: f.environment(), cwd: f.repo });
  await writeFile(saved.workflowFile, "{corrupt", { mode: 0o600 });

  const outside = path.join(f.root, "outside.json");
  await writeFile(outside, "false");
  await symlink(outside, path.join(f.stageDirectory, "research.json"));

  const environment = f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "true", CLAUDE_PLUGIN_OPTION_RESEARCH: "true" });
  const snapshot = await readClaudeWorkflow({ environment, cwd: f.repo });
  const policy = effectiveWorkflow(snapshot);
  assert.equal(policy.workflow.effective, "unknown");
  assert.equal(snapshot.values.research, undefined);
  assert.equal(policy.stages.research.saved, "unknown");
  assert.equal(snapshot.values.plan, false);
  assert.deepEqual([snapshot.sources.workflow, snapshot.sources.research], ["error", "error"]);
});

test("a missing workspace leaves the workflow unknown while profile stages still resolve", async t => {
  const f = await fixture(t);
  await f.save("plan", false);
  for (const cwd of [undefined, 42, path.join(f.root, "missing")]) {
    const snapshot = await readClaudeWorkflow({ environment: f.environment({ CLAUDE_PLUGIN_OPTION_WORKFLOW: "true" }), cwd });
    assert.equal(effectiveWorkflow(snapshot).workflow.effective, "unknown");
    assert.ok(snapshot.errors.workflow);
    assert.equal(snapshot.values.plan, false);
  }
});

test("a symlinked Claude config dir resolves to the same store; an unresolvable one is unknown", async t => {
  const f = await fixture(t);
  await f.save("workflow", false);
  const linked = path.join(f.root, "linked-claude");
  await symlink(f.configDir, linked);

  const snapshot = await readClaudeWorkflow({ environment: { CLAUDE_CONFIG_DIR: linked }, cwd: f.repo });
  assert.equal(effectiveWorkflow(snapshot).workflow.effective, "disabled");
  assert.deepEqual(snapshot.errors, {});
  assert.equal(snapshot.directory, f.stageDirectory);

  const missing = await readClaudeWorkflow({
    environment: { CLAUDE_CONFIG_DIR: path.join(f.root, "absent"), CLAUDE_PLUGIN_OPTION_WORKFLOW: "true" },
    cwd: f.repo,
  });
  assert.equal(effectiveWorkflow(missing).workflow.effective, "unknown");
  assert.ok(["workflow", ...STAGES].every(key => missing.values[key] === undefined && missing.errors[key]));
});

test("repository workflow switches are isolated per checkout", async t => {
  const f = await fixture(t);
  await f.save("workflow", false, f.repo);

  const first = await readClaudeWorkflow({ environment: f.environment(), cwd: path.join(f.repo, ".git") });
  const second = await readClaudeWorkflow({ environment: f.environment(), cwd: f.otherRepo });
  assert.equal(effectiveWorkflow(first).workflow.effective, "disabled");
  assert.equal(effectiveWorkflow(second).workflow.effective, "enabled");
  assert.notEqual(first.workflowFile, second.workflowFile);
});
