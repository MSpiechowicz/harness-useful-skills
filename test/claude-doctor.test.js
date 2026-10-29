import assert from "node:assert/strict";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { probeCodeGraph, runDoctorSetup } from "../doctor-setup.js";
import { pluginDataName, resolveHostContext } from "../claude/host-context.js";
import { assertNoWrites, factsDirectory, fixture } from "./helpers/claude-doctor-fixture.js";

test("the plugin data directory name follows Claude's plugin@marketplace sanitizing rule", () => {
  assert.equal(pluginDataName("harness-useful-skills@harness-useful-skills"), "harness-useful-skills-harness-useful-skills");
  assert.equal(pluginDataName("harness-useful-skills@inline"), "harness-useful-skills-inline");
});

test("first doctor run creates facts and reports the code graph; a second run reuses the facts", async t => {
  const f = await fixture(t);

  const first = await f.run(["doctor"]);
  assert.equal(first.exitCode, 0, first.text);
  assert.match(first.text, /\nSetup\n {2}Facts: created\n {2}Code graph: available\n/);
  assert.doesNotMatch(first.text, /Dependencies|Graphify|Graph:/);
  assert.match(first.text, /\nSetup: complete$/);
  assert.equal(first.text.includes(f.dataDir), false);
  assert.equal((await stat(await factsDirectory(f))).mode & 0o777, 0o700);

  const second = await f.run(["doctor"]);
  assert.equal(second.exitCode, 0, second.text);
  assert.match(second.text, /\nSetup\n {2}Facts: existing\n {2}Code graph: available\n/);

  const check = await f.run(["doctor", "--check"]);
  assert.equal(check.exitCode, 0, check.text);
  assert.match(check.text, /\n {2}Facts: existing\n/);
  assert.match(check.text, /\nStatus only: no setup was performed\.$/);
});

test("doctor --check on an empty data directory reports missing facts and writes nothing", async t => {
  const f = await fixture(t);

  const check = await f.run(["doctor", "--check"]);
  assert.equal(check.exitCode, 1);
  assert.match(check.text, /\nSetup\n {2}Facts: missing\n {2}Code graph: available\n/);
  assert.match(check.text, /\nStatus only: no setup was performed\.$/);
  await assertNoWrites(f);
});

test("the code graph line is informational: an old or missing harness-memory never fails doctor", async t => {
  const old = await fixture(t, { codeGraph: "old" });
  const oldReport = await old.run(["doctor"]);
  assert.equal(oldReport.exitCode, 0, oldReport.text);
  assert.match(oldReport.text, /\n {2}Code graph: not available — update Harness Memory for the code index\n/);
  assert.match(oldReport.text, /\nSetup: complete$/);

  const missing = await fixture(t, { codeGraph: "missing" });
  const missingReport = await missing.run(["doctor"]);
  assert.equal(missingReport.exitCode, 0, missingReport.text);
  assert.match(missingReport.text, /\n {2}Code graph: harness-memory not found — install Harness Memory/);
});

test("a throwing probe is reported as unknown and does not fail doctor", async t => {
  const f = await fixture(t);
  const services = { ...f.services, probeCodeGraph: async () => { throw new Error("boom"); } };
  const report = await f.run(["doctor"], { services });
  assert.equal(report.exitCode, 0, report.text);
  assert.match(report.text, /\n {2}Code graph: unknown\n/);
});

async function stubBinary(t, script) {
  const { chmod, mkdtemp, realpath, rm: remove, writeFile: write } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-probe-")));
  t.after(() => remove(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  await (await import("node:fs/promises")).mkdir(bin);
  await (await import("node:fs/promises")).mkdir(work);
  const stub = async directory => {
    const file = path.join(directory, "harness-memory");
    await write(file, script);
    await chmod(file, 0o755);
    return file;
  };
  return { root, bin, work, stub, path };
}

test("the real probe reads harness-memory features from an absolute path in a neutral directory", async t => {
  const f = await stubBinary(t, "#!/bin/sh\n");
  const file = await f.stub(f.bin);
  const env = { PATH: f.bin };
  const run = features => probeCodeGraph((executable, args, options, done) => {
    assert.equal(executable, file);
    assert.deepEqual(args, ["features"]);
    assert.notEqual(options.cwd, f.work);
    done(features instanceof Error ? features : null, features instanceof Error ? "" : features);
  }, { cwd: f.work, env, home: f.root });
  assert.deepEqual(await run("notes-hide\ncode-index\n"), { outcome: "available", state: "ok" });
  assert.equal((await run("notes-hide\n")).outcome, "not available");
  assert.equal((await run("code-index-v0\n")).outcome, "not available");
  assert.equal((await run(new Error("ENOENT"))).outcome, "harness-memory not found");
  assert.equal((await probeCodeGraph(() => { throw new Error("spawn"); }, { cwd: f.work, env, home: f.root })).outcome, "harness-memory not found");
});

test("an empty or relative PATH entry and a binary in the workspace are never executed", async t => {
  const f = await stubBinary(t, "#!/bin/sh\necho code-index\n");
  await f.stub(f.work);
  const inside = f.path.join(f.work, "tools");
  await (await import("node:fs/promises")).mkdir(inside);
  await f.stub(inside);
  const previous = process.cwd();
  process.chdir(f.work);
  t.after(() => process.chdir(previous));
  let executed = false;
  const execute = () => { executed = true; };
  for (const PATH of ["", ":", `:${f.path.delimiter}.`, ".", "tools", inside]) {
    const result = await probeCodeGraph(execute, { cwd: f.work, env: { PATH }, home: f.root });
    assert.equal(result.outcome, "harness-memory not found", PATH);
  }
  assert.equal(executed, false);
});

test("a binary in the checkout is never executed through a symlinked alias or from a subfolder of the checkout", async t => {
  const { mkdir: makeDirectory, symlink } = await import("node:fs/promises");
  const f = await stubBinary(t, "#!/bin/sh\necho code-index\n");
  await makeDirectory(f.path.join(f.work, ".git"));
  const venv = f.path.join(f.work, ".venv", "bin");
  await makeDirectory(venv, { recursive: true });
  await f.stub(venv);
  const alias = f.path.join(f.root, "alias");
  await symlink(f.work, alias);
  const sub = f.path.join(f.work, "src");
  await makeDirectory(sub);

  let executed = false;
  const execute = () => { executed = true; };
  const aliased = await probeCodeGraph(execute, { cwd: f.work, env: { PATH: f.path.join(alias, ".venv", "bin") }, home: f.root });
  assert.equal(aliased.outcome, "harness-memory not found");
  const fromSubfolder = await probeCodeGraph(execute, { cwd: sub, env: { PATH: venv }, home: f.root });
  assert.equal(fromSubfolder.outcome, "harness-memory not found");
  assert.equal(executed, false);
});

test("a probe that ignores SIGTERM is killed within the time budget", async t => {
  const f = await stubBinary(t, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
  const file = await f.stub(f.bin);
  const { execFile } = await import("node:child_process");
  let child;
  const started = Date.now();
  const result = await probeCodeGraph((executable, args, options, done) => {
    child = execFile(executable, args, options, done);
    return child;
  }, { cwd: f.work, env: { PATH: f.bin }, home: f.root });
  assert.equal(result.outcome, "harness-memory not found");
  assert.ok(Date.now() - started < 3600);
  await new Promise(resolve => child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", resolve));
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(file, child.spawnfile);
});

test("an unsafe facts directory fails setup and skips nothing informational", async t => {
  const f = await fixture(t);
  const facts = await factsDirectory(f);
  await mkdir(facts, { recursive: true, mode: 0o700 });
  await chmod(facts, 0o755);

  const setup = await f.run(["doctor"]);
  assert.equal(setup.exitCode, 1);
  assert.match(setup.text, /\n {2}Facts: failed — Claude facts directory must be a private non-symlink directory\.\n {2}Code graph: available\n/);
});

test("the time budget stops the facts step and asks for another run", async t => {
  const f = await fixture(t);
  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const aborted = await runDoctorSetup({ ...host, signal: AbortSignal.abort(), services: f.services });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.timedOut, true);
  assert.deepEqual(aborted.steps.map(step => step.outcome), ["skipped", "available"]);
});

test("memory status errors hide the plugin data directory and escape invisible characters", async t => {
  const f = await fixture(t);
  const services = {
    ...f.services,
    executeMemory: async () => ({
      ok: false,
      native: { ok: false, error: `Native store failed at ${f.dataDir}/facts‮` },
    }),
  };

  const report = await f.run(["doctor", "--check"], { services });
  assert.match(report.text, /\n {2}Native: Error — Native store failed at <plugin data>\/facts\\u202e\n/);
  assert.equal(report.text.includes(f.dataDir), false);
  assert.doesNotMatch(report.text, /[​‮]/);
});

test("doctor reports saved settings with their sources and writes no settings files", async t => {
  const f = await fixture(t);

  const defaults = await f.run(["doctor", "--check"], { environment: { CLAUDE_PLUGIN_OPTION_PLAN: "false" } });
  assert.match(defaults.text, /\nSettings\n {2}Workflow: enabled \(default\)\n {2}Research: enabled \(default\)\n {2}Plan: disabled \(option\)\n/);
  assert.match(defaults.text, /\n {2}Code graph: enabled \(default\)\n/);
  await assertNoWrites(f);

  const saved = await f.run(["stage", "review", "disabled"], { project: f.repo });
  assert.equal(saved.exitCode, 0, saved.text);
  const settingsFiles = await readdir(path.join(f.configDir, "harness-useful-skills"), { recursive: true });

  const file = await f.run(["doctor"]);
  assert.match(file.text, /\n {2}Review: disabled \(file\)\n/);
  assert.deepEqual(await readdir(path.join(f.configDir, "harness-useful-skills"), { recursive: true }), settingsFiles);
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
