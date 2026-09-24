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
  await mkdir(agentDir);
  await mkdir(otherProfile);
  return { root, agentDir, otherProfile, directory: path.join(agentDir, "useful-skills", "workflow-settings") };
}

test("reads defaults without creating state and persists independent profile-level values", async t => {
  const f = await fixture(t);
  const before = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.equal(before.directory, f.directory);
  assert.deepEqual(before.values, Object.fromEntries(keys.map(key => [key, true])));
  assert.deepEqual(before.errors, {});
  assert.deepEqual(await readdir(f.agentDir), []);

  await writeWorkflowSetting({ agentDir: f.agentDir, key: "workflow", enabled: false });
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "research", enabled: false });
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "review", enabled: false });
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "workflow", enabled: true });
  const resumed = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.deepEqual(resumed.values, { workflow: true, research: false, plan: true, review: false,
    "security-review": true, "backend-memory": true, "graphify-memory": true });
  assert.deepEqual(resumed.errors, {});
  assert.deepEqual((await readWorkflowSettings({ agentDir: f.otherProfile })).values,
    Object.fromEntries(keys.map(key => [key, true])));
  assert.deepEqual(await readdir(f.otherProfile), []);
  assert.deepEqual((await readdir(f.directory)).sort(), ["research.json", "review.json", "workflow.json"]);
  for (const directory of [path.dirname(f.directory), f.directory]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  for (const key of ["workflow", "research", "review"]) {
    assert.equal((await stat(path.join(f.directory, `${key}.json`))).mode & 0o777, 0o600);
  }
});

test("concurrent writes to different switches do not lose updates", async t => {
  const f = await fixture(t);
  // Initialize the managed directory before concurrent per-key writes.
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "workflow", enabled: false });
  assert.deepEqual(await Promise.all(STAGES.map(key => writeWorkflowSetting({ agentDir: f.agentDir, key, enabled: false }))),
    STAGES.map(() => false));
  assert.deepEqual((await readWorkflowSettings({ agentDir: f.agentDir })).values,
    Object.fromEntries(keys.map(key => [key, false])));
});

test("invalid profile, keys and values never create settings or overwrite prior state", async t => {
  const f = await fixture(t);
  await assert.rejects(readWorkflowSettings({ agentDir: path.join(f.root, "missing") }), /profile/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.otherProfile, key: "../workflow", enabled: false }), /setting/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.otherProfile, key: "plan", enabled: "false" }), /boolean/i);
  assert.deepEqual(await readdir(f.otherProfile), []);
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: false });
  await assert.rejects(writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: null }), /boolean/i);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.plan, false);
  assert.equal(await readFile(path.join(f.directory, "plan.json"), "utf8"), "false");
  assert.deepEqual(await readdir(f.directory), ["plan.json"]);
});

test("failed write through an unsafe managed path retains the previously saved value", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: false });
  const original = path.join(f.root, "saved-settings");
  await rename(f.directory, original);
  await symlink(f.root, f.directory);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: true }), /symlink|directory/i);
  assert.equal(await readFile(path.join(original, "plan.json"), "utf8"), "false");
  await rm(f.directory);
  await rename(original, f.directory);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.plan, false);
});

test("malformed and non-boolean files report isolated errors and explicit writes recover regular files", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: false });
  await writeFile(path.join(f.directory, "research.json"), "{private settings should not be displayed");
  await writeFile(path.join(f.directory, "review.json"), "null");
  const invalid = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.equal(invalid.values.plan, false);
  assert.equal(invalid.values.research, undefined);
  assert.equal(invalid.values.review, undefined);
  assert.match(invalid.errors.research, /JSON boolean/i);
  assert.match(invalid.errors.review, /JSON boolean/i);
  assert.doesNotMatch(JSON.stringify(invalid.errors), /private settings/);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ["research", "review"]);
  assert.equal(await writeWorkflowSetting({ agentDir: f.agentDir, key: "research", enabled: false }), false);
  assert.equal(await writeWorkflowSetting({ agentDir: f.agentDir, key: "review", enabled: true }), true);
  const recovered = await readWorkflowSettings({ agentDir: f.agentDir });
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
  await assert.rejects(readWorkflowSettings({ agentDir: linkProfile }), /symbolic links/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: linkProfile, key: "plan", enabled: false }), /symbolic links/i);
  const managed = path.join(f.agentDir, "useful-skills");
  await symlink(outside, managed);
  const unsafe = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.deepEqual(Object.keys(unsafe.errors), keys);
  assert.ok(keys.every(key => unsafe.values[key] === undefined));
  await assert.rejects(writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: false }), /symlink|directory/i);
  assert.deepEqual(await readdir(outside), ["keep"]);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "untouched");
});

test("unsafe per-key target cannot redirect writes or hide read failures", async t => {
  const f = await fixture(t);
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "plan", enabled: false });
  const outside = path.join(f.root, "outside.json");
  await writeFile(outside, "true");
  await symlink(outside, path.join(f.directory, "research.json"));
  const unsafe = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.equal(unsafe.values.plan, false);
  assert.equal(unsafe.values.research, undefined);
  assert.match(unsafe.errors.research, /safely|regular/i);
  await assert.rejects(writeWorkflowSetting({ agentDir: f.agentDir, key: "research", enabled: false }), /non-symlink/i);
  assert.equal(await readFile(outside, "utf8"), "true");
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.plan, false);
  assert.deepEqual((await readdir(f.directory)).sort(), ["plan.json", "research.json"]);
});

test("reads do not repair permissive ancestors; an explicit write makes them private", async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.directory), { mode: 0o755 });
  await chmod(path.dirname(f.directory), 0o755);
  const unsafe = await readWorkflowSettings({ agentDir: f.agentDir });
  assert.equal(unsafe.values.workflow, undefined);
  assert.match(unsafe.errors.workflow, /private/i);
  assert.equal((await lstat(path.dirname(f.directory))).mode & 0o777, 0o755);
  await assert.rejects(stat(f.directory), { code: "ENOENT" });
  await writeWorkflowSetting({ agentDir: f.agentDir, key: "workflow", enabled: false });
  assert.equal((await stat(path.dirname(f.directory))).mode & 0o777, 0o700);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.workflow, false);
});
