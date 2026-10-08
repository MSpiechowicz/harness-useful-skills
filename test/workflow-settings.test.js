import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGES, readWorkflowSettings, writeWorkflowSetting } from "../workflow-settings.js";

const keys = ["workflow", ...STAGES];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-workflow-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "profile");
  const otherProfile = path.join(root, "other-profile");
  const cwd = path.join(root, "workspace");
  await Promise.all([agentDir, otherProfile, cwd].map(directory => mkdir(directory)));
  const options = { agentDir, cwd };
  return { root, agentDir, otherProfile, cwd, options,
    directory: path.join(agentDir, "useful-skills", "workflow-settings") };
}

test("reads defaults without creating state and persists repository master and profile stages", async t => {
  const f = await fixture(t);
  const before = await readWorkflowSettings(f.options);
  assert.equal(before.directory, f.directory);
  assert.equal(before.scopeRoot, f.cwd);
  assert.ok(before.workflowFile.startsWith(path.join(f.directory, "repositories") + path.sep));
  assert.deepEqual(before.values, Object.fromEntries(keys.map(key => [key, true])));
  assert.deepEqual(before.errors, {});
  assert.deepEqual(await readdir(f.agentDir), []);
  assert.deepEqual(await readdir(f.cwd), []);

  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: false });
  await writeWorkflowSetting({ ...f.options, key: "research", enabled: false });
  await writeWorkflowSetting({ ...f.options, key: "review", enabled: false });
  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: true });
  const resumed = await readWorkflowSettings(f.options);
  assert.deepEqual(resumed.values, { workflow: true, research: false, plan: true, review: false,
    "security-review": true, "backend-memory": true, "graphify-memory": true });
  assert.deepEqual(resumed.errors, {});
  assert.deepEqual((await readWorkflowSettings({ agentDir: f.otherProfile, cwd: f.cwd })).values,
    Object.fromEntries(keys.map(key => [key, true])));
  assert.deepEqual(await readdir(f.otherProfile), []);
  assert.deepEqual((await readdir(f.directory)).sort(), ["repositories", "research.json", "review.json"]);
  for (const directory of [path.dirname(f.directory), f.directory,
    path.join(f.directory, "repositories"), path.dirname(resumed.workflowFile)]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  for (const file of [resumed.workflowFile, ...["research", "review"].map(key => path.join(f.directory, `${key}.json`))]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(f.cwd), []);
});

test("concurrent writes to different switches do not lose updates", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: false });
  assert.deepEqual(await Promise.all(STAGES.map(key => writeWorkflowSetting({ ...f.options, key, enabled: false }))),
    STAGES.map(() => false));
  assert.deepEqual((await readWorkflowSettings(f.options)).values,
    Object.fromEntries(keys.map(key => [key, false])));
});

test("invalid profile, keys and values never create settings or overwrite prior state", async t => {
  const f = await fixture(t);
  await assert.rejects(readWorkflowSettings({ agentDir: path.join(f.root, "missing"), cwd: f.cwd }), /profile/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.otherProfile, key: "../workflow", enabled: false }), /setting/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.otherProfile, key: "plan", enabled: "false" }), /boolean/i);
  assert.deepEqual(await readdir(f.otherProfile), []);
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  await assert.rejects(writeWorkflowSetting({ ...f.options, key: "plan", enabled: null }), /boolean/i);
  assert.equal((await readWorkflowSettings(f.options)).values.plan, false);
  assert.equal(await readFile(path.join(f.directory, "plan.json"), "utf8"), "false");
  assert.deepEqual(await readdir(f.directory), ["plan.json"]);
});

test("failed write through an unsafe managed path retains the previously saved value", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  const original = path.join(f.root, "saved-settings");
  await rename(f.directory, original);
  await symlink(f.root, f.directory);
  await assert.rejects(writeWorkflowSetting({ ...f.options, key: "plan", enabled: true }), /symlink|directory/i);
  assert.equal(await readFile(path.join(original, "plan.json"), "utf8"), "false");
  await rm(f.directory);
  await rename(original, f.directory);
  assert.equal((await readWorkflowSettings(f.options)).values.plan, false);
});

test("malformed and non-boolean files report isolated errors and explicit writes recover regular files", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  await writeFile(path.join(f.directory, "research.json"), "{private settings should not be displayed", { mode: 0o600 });
  await writeFile(path.join(f.directory, "review.json"), "null", { mode: 0o600 });
  const invalid = await readWorkflowSettings(f.options);
  assert.equal(invalid.values.plan, false);
  assert.equal(invalid.values.research, undefined);
  assert.equal(invalid.values.review, undefined);
  assert.match(invalid.errors.research, /JSON boolean/i);
  assert.match(invalid.errors.review, /JSON boolean/i);
  assert.doesNotMatch(JSON.stringify(invalid.errors), /private settings/);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ["research", "review"]);
  assert.equal(await writeWorkflowSetting({ ...f.options, key: "research", enabled: false }), false);
  assert.equal(await writeWorkflowSetting({ ...f.options, key: "review", enabled: true }), true);
  const recovered = await readWorkflowSettings(f.options);
  assert.equal(recovered.values.research, false);
  assert.equal(recovered.values.review, true);
  assert.deepEqual(recovered.errors, {});
});

test("symlinked profile or managed ancestor cannot redirect read or write", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep"), "untouched");
  const linkProfile = path.join(f.root, "linked-profile");
  await symlink(f.agentDir, linkProfile);
  await assert.rejects(readWorkflowSettings({ agentDir: linkProfile, cwd: f.cwd }), /symbolic links/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: linkProfile, key: "plan", enabled: false }), /symbolic links/i);
  const managed = path.join(f.agentDir, "useful-skills");
  await symlink(outside, managed);
  const unsafe = await readWorkflowSettings(f.options);
  assert.deepEqual(Object.keys(unsafe.errors), keys);
  assert.ok(keys.every(key => unsafe.values[key] === undefined));
  await assert.rejects(writeWorkflowSetting({ ...f.options, key: "plan", enabled: false }), /symlink|directory/i);
  assert.deepEqual(await readdir(outside), ["keep"]);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "untouched");
});

test("unsafe per-key target cannot redirect writes or hide read failures", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  const outside = path.join(f.root, "outside.json");
  await writeFile(outside, "true");
  await symlink(outside, path.join(f.directory, "research.json"));
  const unsafe = await readWorkflowSettings(f.options);
  assert.equal(unsafe.values.plan, false);
  assert.equal(unsafe.values.research, undefined);
  assert.match(unsafe.errors.research, /safely|regular/i);
  await assert.rejects(writeWorkflowSetting({ ...f.options, key: "research", enabled: false }), /non-symlink/i);
  assert.equal(await readFile(outside, "utf8"), "true");
  assert.equal((await readWorkflowSettings(f.options)).values.plan, false);
  assert.deepEqual((await readdir(f.directory)).sort(), ["plan.json", "research.json"]);
});

test("reads do not repair permissive ancestors; an explicit write makes them private", async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.directory), { mode: 0o755 });
  await chmod(path.dirname(f.directory), 0o755);
  const unsafe = await readWorkflowSettings(f.options);
  assert.equal(unsafe.values.workflow, undefined);
  assert.match(unsafe.errors.workflow, /private/i);
  assert.equal((await lstat(path.dirname(f.directory))).mode & 0o777, 0o755);
  await assert.rejects(stat(f.directory), { code: "ENOENT" });
  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: false });
  assert.equal((await stat(path.dirname(f.directory))).mode & 0o777, 0o700);
  assert.equal((await readWorkflowSettings(f.options)).values.workflow, false);
});

test("oversized settings remain unknown and readable stage files survive repository master cutover unchanged", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  const file = path.join(f.directory, "plan.json");
  const oversized = " ".repeat(4097);
  await writeFile(file, oversized);
  const invalid = await readWorkflowSettings(f.options);
  assert.equal(invalid.values.plan, undefined);
  assert.match(invalid.errors.plan, /size limit/);
  assert.equal(await readFile(file, "utf8"), oversized);

  await writeFile(file, "false\n");
  await chmod(file, 0o644);
  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: false });
  const compatible = await readWorkflowSettings(f.options);
  assert.equal(compatible.values.workflow, false);
  assert.equal(compatible.values.plan, false);
  assert.deepEqual(compatible.errors, {});
  assert.equal(await readFile(file, "utf8"), "false\n");
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test("sources report whether each value came from a saved file, a missing file, or an error", async t => {
  const f = await fixture(t);
  assert.deepEqual((await readWorkflowSettings(f.options)).sources,
    Object.fromEntries(keys.map(key => [key, "default"])));

  await writeWorkflowSetting({ ...f.options, key: "workflow", enabled: true });
  await writeWorkflowSetting({ ...f.options, key: "plan", enabled: false });
  await writeFile(path.join(f.directory, "review.json"), "not json", { mode: 0o600 });
  const saved = await readWorkflowSettings(f.options);
  assert.deepEqual(saved.sources, { workflow: "file", research: "default", plan: "file", review: "error",
    "security-review": "default", "backend-memory": "default", "graphify-memory": "default" });

  const unscoped = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.equal(unscoped.sources.workflow, "error");
  assert.equal(unscoped.sources.plan, "file");

  await chmod(path.dirname(f.directory), 0o755);
  const unsafe = await readWorkflowSettings(f.options);
  assert.ok(keys.every(key => unsafe.sources[key] === "error"));
});
