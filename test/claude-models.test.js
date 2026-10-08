import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../claude/hooks.js";
import { modelRoutingContext, modelsConfigPath, parseModelsConfig, syncRoleAgents } from "../claude/models.js";
import { readClaudeWorkflow } from "../claude/settings.js";

async function configDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function permissions(file) {
  return (await stat(file)).mode & 0o777;
}

function agentPath(directory, agent) {
  return path.join(directory, "agents", `useful-skills-${agent}.md`);
}

test("first session creates the default model config and one role agent per plugin agent", async t => {
  const directory = await configDir(t);
  const result = syncRoleAgents({ configDir: directory });

  assert.equal(result.created, true);
  assert.equal(result.configFile, modelsConfigPath(directory));
  const config = await readFile(result.configFile, "utf8");
  assert.match(config, /^ {2}default: claude-opus-5-5:medium$/m);
  assert.match(config, /^ {2}review: claude-sonnet-5-5:medium$/m);

  assert.deepEqual((await readdir(path.join(directory, "agents"))).sort(), [
    "useful-skills-backend.md",
    "useful-skills-frontend.md",
    "useful-skills-general-purpose.md",
    "useful-skills-planner.md",
    "useful-skills-reviewer.md",
    "useful-skills-scout.md",
    "useful-skills-security-reviewer.md",
  ]);
  const backend = await readFile(agentPath(directory, "backend"), "utf8");
  assert.match(backend, /^name: us-backend$/m);
  assert.match(backend, /^model: claude-opus-5-5$/m);
  assert.match(backend, /^effort: high$/m);
  assert.match(backend, /^tools: Read, Grep, Glob, Edit, Write, Bash$/m);
  assert.doesNotMatch(backend, /the plugin's `claude\//);
  const general = await readFile(agentPath(directory, "general-purpose"), "utf8");
  assert.match(general, /^model: claude-sonnet-5-5$/m);
  assert.ok(Object.values(result.agents).every(agent => agent.state === "created"));
});

test("later sessions regenerate only changed agents and fall back to the default role", async t => {
  const directory = await configDir(t);
  syncRoleAgents({ configDir: directory });
  assert.ok(Object.values(syncRoleAgents({ configDir: directory }).agents).every(agent => agent.state === "ready"));

  await writeFile(modelsConfigPath(directory), "modelRoles:\n  review: anthropic/claude-opus-5-5:xhigh\n  default: \"sonnet\"\n");
  const result = syncRoleAgents({ configDir: directory });
  assert.equal(result.created, false);
  assert.equal(result.agents.reviewer.state, "updated");
  assert.deepEqual(result.agents.reviewer.selection, { model: "claude-opus-5-5", effort: "xhigh" });
  assert.deepEqual(result.agents.scout.selection, { model: "sonnet", effort: undefined });
  const scout = await readFile(agentPath(directory, "scout"), "utf8");
  assert.match(scout, /^model: sonnet$/m);
  assert.doesNotMatch(scout, /^effort:/m);
});

test("invalid configuration and user-owned agent files are never overwritten", async t => {
  const directory = await configDir(t);
  await mkdir(path.join(directory, "agents"), { recursive: true });
  await writeFile(agentPath(directory, "planner"), "---\nname: mine\n---\nkeep\n");
  const first = syncRoleAgents({ configDir: directory });
  assert.equal(first.agents.planner.state, "conflict");
  assert.equal(await readFile(agentPath(directory, "planner"), "utf8"), "---\nname: mine\n---\nkeep\n");
  assert.match(modelRoutingContext(first), /dispatch `useful-skills:planner` \(inherits the session model\)/);

  const before = await readFile(agentPath(directory, "backend"), "utf8");
  await writeFile(modelsConfigPath(directory), "modelRoles:\n  backend: claude-opus-5-5:extreme\n");
  const invalid = syncRoleAgents({ configDir: directory });
  assert.match(invalid.error, /Invalid selector for role "backend"/);
  assert.deepEqual(invalid.agents, {});
  assert.equal(await readFile(agentPath(directory, "backend"), "utf8"), before);
  assert.match(modelRoutingContext(invalid), /That file is invalid/);
});

test("the parser accepts only known roles and safe selectors", () => {
  assert.throws(() => parseModelsConfig("modelRoles:\n  reserch: opus\n"), /Unknown role "reserch"/);
  assert.throws(() => parseModelsConfig("modelRoles:\n  plan: opus\n  plan: sonnet\n"), /more than once/);
  assert.throws(() => parseModelsConfig("modelRoles:\n  plan: opus\nmodel: x\n"), /line 3/);
  assert.throws(() => parseModelsConfig("modelRoles:\n  plan: \"opus\\nevil: 1\"\n"), /line 2/);
  assert.throws(() => parseModelsConfig("research: opus\n"), /line 1/);
  assert.throws(() => parseModelsConfig("# empty\n"), /Missing `modelRoles:`/);
  assert.deepEqual(parseModelsConfig("# roles\nmodelRoles:  # comment\n  plan: claude-opus-5-5:max # deep\n"), {
    plan: { model: "claude-opus-5-5", effort: "max" },
  });
});

test("SessionStart hook syncs role agents and tells the parent which agent to dispatch", async t => {
  const directory = await configDir(t);
  const context = handleHook({ hook_event_name: "SessionStart", source: "startup" }, { CLAUDE_CONFIG_DIR: directory })
    ?.hookSpecificOutput?.additionalContext;

  assert.match(context, /created with defaults this session/);
  assert.match(context, /useful-skills:security-reviewer: dispatch `us-security-reviewer` \(claude-opus-5-5, effort high\)/);
  assert.match(context, /load after Claude Code restarts/);
  assert.match(context, /do not pass a `model` in the Agent call/);
});

test("a fresh config dir gets a private useful-skills directory", async t => {
  const directory = await configDir(t);
  syncRoleAgents({ configDir: directory });

  assert.equal(await permissions(path.join(directory, "useful-skills")), 0o700);
});

test("an existing shared useful-skills directory is made private so workflow settings stay readable", async t => {
  const directory = await configDir(t);
  const shared = path.join(directory, "useful-skills");
  await mkdir(shared);
  await chmod(shared, 0o755);
  await writeFile(modelsConfigPath(directory), "modelRoles:\n  default: sonnet\n");

  const repository = await configDir(t);
  await mkdir(path.join(repository, ".git"));
  const before = await readClaudeWorkflow({ environment: { CLAUDE_CONFIG_DIR: directory }, cwd: repository });
  assert.equal(before.sources.workflow, "error");

  const result = syncRoleAgents({ configDir: directory });
  assert.equal(result.created, false);
  assert.equal(await permissions(shared), 0o700);

  const workflow = await readClaudeWorkflow({ environment: { CLAUDE_CONFIG_DIR: directory }, cwd: repository });
  assert.deepEqual(workflow.errors, {});
  assert.ok(Object.values(workflow.sources).every(source => source === "default"));
});

test("a symlinked useful-skills directory is not followed or made private", async t => {
  const directory = await configDir(t);
  const target = await configDir(t);
  await chmod(target, 0o755);
  await symlink(target, path.join(directory, "useful-skills"));

  syncRoleAgents({ configDir: directory });
  assert.equal(await permissions(target), 0o755);
});
