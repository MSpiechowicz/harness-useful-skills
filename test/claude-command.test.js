import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runCommand } from "../claude/command.js";
import { STAGES } from "../workflow-settings.js";

const execute = promisify(execFile);
const COMMAND = fileURLToPath(new URL("../claude/command.js", import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-claude-command-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = path.join(root, "claude");
  const repo = path.join(root, "repo");
  const otherRepo = path.join(root, "other-repo");
  for (const directory of [configDir, path.join(repo, ".git"), path.join(otherRepo, ".git")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const environment = (options = {}) => ({ CLAUDE_CONFIG_DIR: configDir, ...options });
  return {
    root, configDir, repo, otherRepo,
    stageDirectory: path.join(configDir, "useful-skills", "workflow-settings"),
    environment,
    run: (argv, { cwd = repo, options } = {}) => runCommand(argv, { environment: environment(options), cwd }),
  };
}

async function statusJson(f, options = {}) {
  const { text, exitCode } = await f.run(["status", "--json"], options);
  assert.equal(exitCode, 0);
  return JSON.parse(text);
}

async function storedFiles(directory) {
  try {
    return await readdir(directory, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("status reports scope, paths, and per-key saved/effective/source as text and JSON", async t => {
  const f = await fixture(t);

  const text = await f.run(["status"]);
  assert.equal(text.exitCode, 0);
  assert.match(text.text, new RegExp(`Workflow scope root: ${f.repo}\n`));
  assert.match(text.text, new RegExp(`Profile stage directory: ${f.stageDirectory}\n`));
  assert.match(text.text, /Workflow: saved enabled, effective enabled, source default\n/);
  assert.match(text.text, /Security review: saved enabled, effective enabled, source default\n/);

  const json = await statusJson(f);
  assert.deepEqual(Object.keys(json).sort(), ["directory", "scopeRoot", "stages", "workflow", "workflowFile"]);
  assert.equal(json.scopeRoot, f.repo);
  assert.equal(json.directory, f.stageDirectory);
  assert.equal(path.dirname(path.dirname(json.workflowFile)), path.join(f.stageDirectory, "repositories"));
  assert.deepEqual(json.workflow, { saved: "enabled", effective: "enabled", source: "default" });
  assert.deepEqual(Object.keys(json.stages), STAGES);
  for (const stage of STAGES) {
    assert.deepEqual(json.stages[stage], { saved: "enabled", effective: "enabled", source: "default" });
  }
});

test("status reports an unreadable workspace without failing", async t => {
  const f = await fixture(t);
  const missing = path.join(f.root, "missing");

  const json = await statusJson(f, { cwd: missing });
  assert.equal(json.scopeRoot, null);
  assert.equal(json.workflowFile, null);
  assert.equal(json.workflow.saved, "unknown");
  assert.equal(json.workflow.source, "error");
  assert.equal(typeof json.workflow.error, "string");
  assert.deepEqual(json.stages.plan, { saved: "enabled", effective: "unknown", source: "default" });

  const text = await f.run(["status"], { cwd: missing });
  assert.equal(text.exitCode, 0);
  assert.match(text.text, /Workflow scope root: unknown/);
  assert.match(text.text, /Plan: saved enabled, effective unknown, source default \(workflow setting unreadable\)/);
});

test("workflow and stage writes create private files at the shared store paths, separated per repository", async t => {
  const f = await fixture(t);

  const workflow = await f.run(["workflow", "disabled"]);
  assert.deepEqual(workflow, { text: `Useful Skills workflow disabled for this repository/workspace (${f.repo}).`, exitCode: 0 });

  const stage = await f.run(["stage", "review", "disabled"]);
  assert.deepEqual(stage, { text: "Useful Skills review disabled for this Claude profile.", exitCode: 0 });

  const json = await statusJson(f);
  assert.deepEqual(json.workflow, { saved: "disabled", effective: "disabled", source: "file" });
  assert.deepEqual(json.stages.review, { saved: "disabled", effective: "disabled", source: "file" });
  assert.deepEqual(json.stages.plan, { saved: "enabled", effective: "disabled", source: "default" });

  const reviewFile = path.join(f.stageDirectory, "review.json");
  assert.equal(await readFile(reviewFile, "utf8"), "false");
  assert.equal(await readFile(json.workflowFile, "utf8"), "false");
  for (const file of [reviewFile, json.workflowFile]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  for (const directory of [path.join(f.configDir, "useful-skills"), f.stageDirectory, path.dirname(json.workflowFile)]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }

  const other = await statusJson(f, { cwd: f.otherRepo });
  assert.notEqual(other.workflowFile, json.workflowFile);
  assert.deepEqual(other.workflow, { saved: "enabled", effective: "enabled", source: "default" });
  assert.deepEqual(other.stages.review, { saved: "disabled", effective: "disabled", source: "file" });

  const text = await f.run(["status"]);
  assert.match(text.text, /Plan: saved enabled, effective disabled, source default \(workflow disabled\)/);
});

test("a saved stage overrides its plugin option and underscore aliases name hyphenated stages", async t => {
  const f = await fixture(t);
  const options = { CLAUDE_PLUGIN_OPTION_PLAN: "false" };

  const before = await statusJson(f, { options });
  assert.deepEqual(before.stages.plan, { saved: "disabled", effective: "disabled", source: "option" });

  const enabled = await f.run(["stage", "plan", "enabled"], { options });
  assert.equal(enabled.exitCode, 0);
  const after = await statusJson(f, { options });
  assert.deepEqual(after.stages.plan, { saved: "enabled", effective: "enabled", source: "file" });

  const alias = await f.run(["stage", "security_review", "disabled"]);
  assert.deepEqual(alias, { text: "Useful Skills security-review disabled for this Claude profile.", exitCode: 0 });
  assert.equal(await readFile(path.join(f.stageDirectory, "security-review.json"), "utf8"), "false");

  const invalidOption = await statusJson(f, { options: { CLAUDE_PLUGIN_OPTION_REVIEW: "maybe" } });
  assert.equal(invalidOption.stages.review.source, "option");
  assert.equal(invalidOption.stages.review.saved, "unknown");
  assert.equal(typeof invalidOption.stages.review.error, "string");
});

test("invalid setting commands fail with usage and status and write nothing", async t => {
  const f = await fixture(t);

  for (const argv of [
    ["stage", "../x", "enabled"],
    ["stage", "plan"],
    ["stage", "plan", "on"],
    ["workflow", "maybe"],
    ["workflow", "disabled", "now"],
    ["workflow"],
  ]) {
    const { text, exitCode } = await f.run(argv);
    assert.notEqual(exitCode, 0, argv.join(" "));
    assert.match(text, /^Expected \/useful-skills (stage|workflow) /);
    assert.match(text, /Workflow: saved enabled, effective enabled, source default/);
  }

  assert.deepEqual(await storedFiles(path.join(f.configDir, "useful-skills")), []);
});

test("a workflow write outside a resolvable workspace fails without a stack trace", async t => {
  const f = await fixture(t);

  const { text, exitCode } = await f.run(["workflow", "disabled"], { cwd: path.join(f.root, "missing") });
  assert.equal(exitCode, 1);
  assert.equal(text, "Cannot change workflow: Cannot resolve active workspace directory.");
});

test("arguments are bounded and unknown commands show help with a failure", async t => {
  const f = await fixture(t);

  for (const argv of [
    ["list", "a", "b", "c", "d", "e", "f", "g", "h"],
    ["list a b c d e f g h"],
    ["list", "x".repeat(257)],
    [1],
    "status",
    ["bogus"],
    ["help", "me"],
    ["doctor", "now"],
    ["status", "--yaml"],
    ["update"],
    ["update", "now"],
    ["library"],
    ["library", "agents"],
  ]) {
    const { text, exitCode } = await f.run(argv);
    assert.notEqual(exitCode, 0, JSON.stringify(argv));
    assert.match(text, /\nUseful Skills for Claude Code\n/);
    assert.doesNotMatch(text, /\n\s+at /);
  }

  for (const argv of [["library"], ["library", "agents"], ["status", "--yaml"]]) {
    assert.equal((await f.run(argv)).exitCode, 2, JSON.stringify(argv));
  }

  for (const argv of [[], ["help"], [""]]) {
    const { text, exitCode } = await f.run(argv);
    assert.equal(exitCode, 0);
    assert.match(text, /^Useful Skills for Claude Code\n/);
    assert.match(text, /\/useful-skills:us-ignore-workflow/);
    assert.match(text, /memory_status/);
  }
});

test("list shows Claude skill invocations; library list shows installed reference paths", async t => {
  const f = await fixture(t);

  const list = await f.run(["list", "memory"]);
  assert.equal(list.exitCode, 0);
  assert.match(list.text, /\n {4}\/useful-skills:us-memory(\n|$)/);
  assert.doesNotMatch(list.text, /\/skill:/);

  const split = await f.run(["list memory"]);
  assert.equal(split.text, list.text);

  const library = await f.run(["library", "list", "agents", "architect"]);
  assert.equal(library.exitCode, 0);
  assert.doesNotMatch(library.text, /skill:\/\//);
  const reference = /\n {4}(\/\S+\.md)(\n|$)/.exec(library.text)?.[1];
  assert.ok(reference);
  assert.ok((await stat(reference)).isFile());

  const none = await f.run(["list", "no-such-skill-anywhere"]);
  assert.deepEqual(none, { text: "No skills matching \"no-such-skill-anywhere\".", exitCode: 0 });
});

test("doctor, update, and graph commands give Claude guidance", async t => {
  const f = await fixture(t);

  // This checkout is not installed in the fixture's Claude plugin cache, so memory cannot be located.
  for (const argv of [["doctor"], ["doctor", "--check"]]) {
    const doctor = await f.run(argv);
    assert.equal(doctor.exitCode, 1);
    assert.match(doctor.text, /Core: [1-9]\d* skills, 0 commands, [1-9]\d* agents, 0 rules/);
    assert.match(doctor.text, /Safety: Enabled/);
    assert.match(doctor.text, /\nMemory: not checked — /);
    assert.match(doctor.text, /\nSettings\n {2}Workflow: enabled \(default\)\n/);
    assert.doesNotMatch(doctor.text, /in OMP|Read-only/);
  }
  assert.deepEqual(await storedFiles(f.configDir), []);

  for (const action of ["check", "install"]) {
    assert.deepEqual(await f.run(["update", action]), {
      text: "Claude Code updates the plugin itself: use `/plugin` (Installed tab) or run `claude plugin update useful-skills@<marketplace>`, then `/reload-plugins`.",
      exitCode: 0,
    });
  }

  const graph = await f.run(["graph", "test"]);
  assert.equal(graph.exitCode, 0);
  assert.match(graph.text, /`graph_build`/);
  assert.match(graph.text, /`graph_query`/);
});

test("the CLI prints results to stdout and failures to stderr with the exit code", async t => {
  const f = await fixture(t);
  const options = { cwd: f.repo, env: { ...process.env, ...f.environment() } };

  const ok = await execute(process.execPath, [COMMAND, "status", "--json"], options);
  assert.equal(JSON.parse(ok.stdout).scopeRoot, f.repo);
  assert.equal(ok.stderr, "");

  await assert.rejects(execute(process.execPath, [COMMAND, "workflow", "maybe"], options), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /^Expected \/useful-skills workflow enabled\|disabled\./);
    return true;
  });
});

test("text output escapes control characters in workspace paths so they cannot forge status lines", async t => {
  const f = await fixture(t);
  const forged = path.join(f.root, "repo\nWorkflow: saved disabled, effective disabled, source file");
  await mkdir(path.join(forged, ".git"), { recursive: true });

  const status = await f.run(["status"], { cwd: forged });
  assert.equal(status.exitCode, 0);
  assert.equal(status.text.split("\n").filter(line => line.startsWith("Workflow:")).length, 1);
  assert.match(status.text, /Workflow: saved enabled, effective enabled, source default/);
  assert.ok(status.text.includes(`Workflow scope root: ${f.root}/repo\\u000aWorkflow: saved disabled`));

  const json = await statusJson(f, { cwd: forged });
  assert.equal(json.scopeRoot, forged);

  const written = await f.run(["workflow", "disabled"], { cwd: forged });
  assert.equal(written.exitCode, 0);
  assert.equal(written.text.split("\n").length, 1);
  assert.ok(written.text.includes("repo\\u000aWorkflow: saved disabled"));
});

test("status redacts secret-shaped error reasons in text and JSON", async t => {
  const f = await fixture(t);
  const secret = "secret=abcdefghijkl";
  const options = { CLAUDE_CONFIG_DIR: path.join(f.root, secret) };

  const text = await f.run(["status"], { options });
  assert.equal(text.exitCode, 0);
  assert.match(text.text, /Workflow: saved unknown, effective unknown, source error \(.*secret=\[REDACTED\]/);
  assert.doesNotMatch(text.text, /abcdefghijkl/);

  const json = await statusJson(f, { options });
  assert.match(json.workflow.error, /secret=\[REDACTED\]/);
  assert.match(json.stages.plan.error, /secret=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(json), /abcdefghijkl/);
});

test("text status escapes invisible bidi and format characters in paths", async t => {
  const f = await fixture(t);
  const spoofed = path.join(f.root, "repo\u202Etxt.exe\u200B\u{E0041}");
  await mkdir(path.join(spoofed, ".git"), { recursive: true });

  const status = await f.run(["status"], { cwd: spoofed });
  assert.equal(status.exitCode, 0);
  assert.ok(status.text.includes(`Workflow scope root: ${f.root}/repo\\u202etxt.exe\\u200b\\udb40\\udc41\n`));
  assert.doesNotMatch(status.text, /[\u202E\u200B\u{E0041}]/u);
});

test("the CLI runs when invoked through a symlinked install path", async t => {
  const f = await fixture(t);
  const link = path.join(f.root, "linked-package");
  await symlink(path.dirname(path.dirname(COMMAND)), link, "dir");
  const options = { cwd: f.repo, env: { ...process.env, ...f.environment() } };

  const ok = await execute(process.execPath, [path.join(link, "claude", "command.js"), "status"], options);
  assert.match(ok.stdout, /^Useful Skills repository workflow and Claude profile stage settings:\n/);
  assert.match(ok.stdout, /\nWorkflow: saved enabled, effective enabled, source default\n/);
  assert.equal(ok.stderr, "");
});

test("library commands report an installation without the reference archive", async t => {
  const f = await fixture(t);
  const source = path.dirname(path.dirname(COMMAND));
  const excluded = new Set([".git", "test", path.join("skills", "us-library", "references", "ecc")]);
  const installed = path.join(f.root, "directory-install");
  await cp(source, installed, { recursive: true, filter: file => !excluded.has(path.relative(source, file)) });
  const options = { cwd: f.repo, env: { ...process.env, ...f.environment() } };
  const command = path.join(installed, "claude", "command.js");

  for (const argv of [["library", "list"], ["library", "list", "agents", "architect"]]) {
    const missing = await execute(process.execPath, [command, ...argv], options);
    assert.equal(missing.stdout, "Reference library is not included in this installation.\n");
    assert.equal(missing.stderr, "");
  }

  const core = await execute(process.execPath, [command, "list"], options);
  assert.match(core.stdout, /^Useful Skills core skills \(\d+\):\n/);
});
