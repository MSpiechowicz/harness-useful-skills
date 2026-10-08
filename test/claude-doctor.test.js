import assert from "node:assert/strict";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runClaudeDoctor } from "../claude/doctor-setup.js";
import { pluginDataName, resolveHostContext } from "../claude/host-context.js";
import { workspaceMemoryPaths } from "../graphify.js";
import { assertNoWrites, factsDirectory, fixture, SECRET } from "./helpers/claude-doctor-fixture.js";

test("the plugin data directory name follows Claude's plugin@marketplace sanitizing rule", () => {
  assert.equal(pluginDataName("useful-skills@useful-skills-local"), "useful-skills-useful-skills-local");
  assert.equal(pluginDataName("useful-skills@inline"), "useful-skills-inline");
});

test("first doctor run creates facts, installs dependencies, and builds the graph; a second run reuses them", async t => {
  const f = await fixture(t);

  const first = await f.run(["doctor"]);
  assert.equal(first.exitCode, 0, first.text);
  assert.match(first.text, /\nSetup\n {2}Facts: created\n {2}Dependencies: installed\n {2}Graph: built \(1 nodes, 0 edges\)\n/);
  assert.match(first.text, /\n {2}Graph: Ready — 1 nodes, 0 edges\n/);
  assert.match(first.text, /\nSetup: complete$/);
  assert.equal(first.text.includes(f.dataDir), false);
  assert.deepEqual(f.calls, { install: 1, build: 1 });
  assert.equal((await stat(await factsDirectory(f))).mode & 0o777, 0o700);

  const second = await f.run(["doctor"]);
  assert.equal(second.exitCode, 0, second.text);
  assert.match(second.text, /\nSetup\n {2}Facts: existing\n {2}Dependencies: ready\n {2}Graph: existing \(1 nodes, 0 edges\)\n/);
  assert.deepEqual(f.calls, { install: 1, build: 1 });

  const check = await f.run(["doctor", "--check"]);
  assert.equal(check.exitCode, 0, check.text);
  assert.match(check.text, /\n {2}Facts: existing\n/);
  assert.match(check.text, /\nStatus only: no setup was performed\.$/);
});

test("doctor --check on an empty data directory reports missing setup and writes nothing", async t => {
  const f = await fixture(t);

  const check = await f.run(["doctor", "--check"]);
  assert.equal(check.exitCode, 1);
  assert.match(check.text, /\nSetup\n {2}Facts: missing\n {2}Dependencies: missing\n {2}Graph: missing\n/);
  assert.match(check.text, /\nStatus only: no setup was performed\.$/);
  assert.deepEqual(f.calls, { install: 0, build: 0 });
  await assertNoWrites(f);
});

test("an install failure skips the graph but keeps created facts", async t => {
  const f = await fixture(t, { installError: `download refused ${SECRET}` });

  const setup = await f.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Facts: created\n {2}Dependencies: failed — download refused token=\[REDACTED\]\n {2}Graph: skipped — an earlier step failed\n/);
  assert.equal(setup.text.includes(SECRET), false);
  assert.match(setup.text, /\nSetup: incomplete — run \/useful-skills doctor again after fixing the error$/);
  assert.deepEqual(f.calls, { install: 1, build: 0 });
});

test("a build failure fails setup without publishing a graph", async t => {
  const f = await fixture(t, { buildError: "graphify crashed" });

  const setup = await f.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Dependencies: installed\n {2}Graph: failed — graphify crashed\n/);
  assert.match(setup.text, /\n {2}Graph: Not built\n/);
  assert.deepEqual(f.calls, { install: 1, build: 1 });
});

test("an invalid existing graph is reported without a rebuild", async t => {
  const f = await fixture(t);
  const paths = await workspaceMemoryPaths({ cwd: f.repo, agentDir: f.dataDir });
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await writeFile(paths.current, "not json");

  const setup = await f.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Graph: error — Active graph pointer is invalid/);
  assert.equal(f.calls.build, 0);
});

test("unsupported and partial dependencies are reported without installing", async t => {
  const unsupported = await fixture(t, { dependencyState: "unsupported" });
  const setup = await unsupported.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Dependencies: unsupported — Platform is unsupported\n {2}Graph: skipped — an earlier step failed\n/);
  assert.equal(unsupported.calls.install, 0);

  const partial = await fixture(t, { dependencyState: "partial" });
  const check = await partial.run(["doctor", "--check"]);
  assert.match(check.text, /\n {2}Dependencies: incomplete\n/);
  assert.equal(partial.calls.install, 0);
});

test("an unsafe facts directory fails setup and skips dependent steps", async t => {
  const f = await fixture(t);
  const facts = await factsDirectory(f);
  await mkdir(facts, { recursive: true, mode: 0o700 });
  await chmod(facts, 0o755);

  const setup = await f.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Facts: failed — Claude facts directory must be a private non-symlink directory\.\n {2}Dependencies: skipped — an earlier step failed\n {2}Graph: skipped — an earlier step failed\n/);
  assert.deepEqual(f.calls, { install: 0, build: 0 });
});

test("the time budget stops setup and asks for another run", async t => {
  const f = await fixture(t, { installError: "wait" });

  const setup = await f.run(["doctor"], { doctorBudgetMs: 20 });
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Dependencies: failed — time limit reached, run again\n {2}Graph: skipped — time limit reached, run again\n/);
  assert.match(setup.text, /\nSetup: partial — run \/useful-skills doctor again to continue$/);
  assert.doesNotMatch(setup.text, /after fixing the error/);

  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const aborted = await runClaudeDoctor({ ...host, signal: AbortSignal.abort(), services: f.services });
  assert.equal(aborted.ok, false);
  assert.deepEqual(aborted.steps.map(step => step.outcome), ["skipped", "skipped", "skipped"]);
});

test("memory status errors hide the plugin data directory and escape invisible characters", async t => {
  const f = await fixture(t);
  const services = {
    ...f.services,
    executeMemory: async () => ({
      ok: false,
      native: { ok: false, error: `Native store failed at ${f.dataDir}/facts‮` },
      graph: {
        error: `Graph pointer unreadable at ${f.dataDir}/graph`,
        dependency: { state: "unsupported", reason: `Runtime missing under ${f.dataDir}​` },
      },
    }),
  };

  const report = await f.run(["doctor", "--check"], { services });
  assert.match(report.text, /\n {2}Native: Error — Native store failed at <plugin data>\/facts\\u202e\n/);
  assert.match(report.text, /\n {2}Graph: Error — Graph pointer unreadable at <plugin data>\/graph\n/);
  assert.match(report.text, /\n {2}Dependencies: Unsupported — Runtime missing under <plugin data>\\u200b\n/);
  assert.equal(report.text.includes(f.dataDir), false);
  assert.doesNotMatch(report.text, /[​‮]/);
});

test("doctor reports saved settings with their sources and writes no settings files", async t => {
  const f = await fixture(t);

  const defaults = await f.run(["doctor", "--check"], { environment: { CLAUDE_PLUGIN_OPTION_PLAN: "false" } });
  assert.match(defaults.text, /\nSettings\n {2}Workflow: enabled \(default\)\n {2}Research: enabled \(default\)\n {2}Plan: disabled \(option\)\n/);
  assert.match(defaults.text, /\n {2}Graphify memory: enabled \(default\)\n/);
  await assertNoWrites(f);

  const saved = await f.run(["stage", "review", "disabled"], { project: f.repo });
  assert.equal(saved.exitCode, 0, saved.text);
  const settingsFiles = await readdir(path.join(f.configDir, "useful-skills"), { recursive: true });

  const file = await f.run(["doctor"]);
  assert.match(file.text, /\n {2}Review: disabled \(file\)\n/);
  assert.deepEqual(await readdir(path.join(f.configDir, "useful-skills"), { recursive: true }), settingsFiles);
});

test("doctor usage accepts only --check", async t => {
  const f = await fixture(t);

  for (const argv of [["doctor", "--fix"], ["doctor", "--check", "now"]]) {
    const report = await f.run(argv);
    assert.equal(report.exitCode, 2);
    assert.match(report.text, /^Expected \/useful-skills doctor \[--check\]\./);
  }
  await assertNoWrites(f);
});
