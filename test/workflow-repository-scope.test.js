import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkflowSettings, writeWorkflowSetting } from "../workflow-settings.js";
import { git } from "./helpers/git-fixture.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-workflow-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "profile");
  await mkdir(agentDir);
  const read = cwd => readWorkflowSettings({ agentDir, cwd });
  const write = (cwd, enabled, key = "workflow") => writeWorkflowSetting({ agentDir, cwd, key, enabled });
  const repository = async name => {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    await git(directory, "init", "--quiet");
    return directory;
  };
  return { root, agentDir, read, write, repository };
}

test("same-profile repositories isolate masters while sharing persisted stage choices", async t => {
  const f = await fixture(t);
  const first = await f.repository("first");
  const second = await f.repository("second");
  await f.write(first, false);
  await f.write(first, false, "plan");
  const a = await f.read(first);
  const b = await f.read(second);
  assert.equal(a.values.workflow, false);
  assert.equal(b.values.workflow, true);
  assert.equal(a.values.plan, false);
  assert.equal(b.values.plan, false);
  assert.notEqual(a.workflowFile, b.workflowFile);
  const restarted = await readWorkflowSettings({ agentDir: f.agentDir, cwd: first });
  assert.equal(restarted.values.workflow, false);
  await f.write(second, true);
  assert.equal((await f.read(first)).values.workflow, false);
  assert.deepEqual(await readdir(first), [".git"]);
  assert.deepEqual(await readdir(second), [".git"]);
});

test("canonical root, subdirectories and symlink aliases share; nested checkout is independent", async t => {
  const f = await fixture(t);
  const repository = await f.repository("repository");
  const subdirectory = path.join(repository, "src", "deep");
  await mkdir(subdirectory, { recursive: true });
  const alias = path.join(f.root, "alias");
  await symlink(repository, alias);
  await f.write(subdirectory, false);
  const root = await f.read(repository);
  for (const cwd of [subdirectory, alias, path.join(alias, "src", "deep")]) {
    const snapshot = await f.read(cwd);
    assert.equal(snapshot.scopeRoot, repository);
    assert.equal(snapshot.workflowFile, root.workflowFile);
    assert.equal(snapshot.values.workflow, false);
  }
  const nested = await f.repository("repository/nested");
  assert.equal((await f.read(nested)).scopeRoot, nested);
  assert.equal((await f.read(nested)).values.workflow, true);
  await f.write(nested, true);
  assert.equal((await f.read(repository)).values.workflow, false);
});

test("linked worktrees share Git administration but not workflow masters", async t => {
  const f = await fixture(t);
  const repository = await f.repository("repository");
  await git(repository, "commit", "--allow-empty", "--quiet", "-m", "initial");
  const worktree = path.join(f.root, "worktree");
  await git(repository, "worktree", "add", "--quiet", "--detach", worktree);
  assert.match(await readFile(path.join(worktree, ".git"), "utf8"), /^gitdir: /);
  await f.write(repository, false);
  const linked = await f.read(worktree);
  assert.equal(linked.scopeRoot, worktree);
  assert.equal(linked.values.workflow, true);
  await f.write(worktree, true);
  assert.equal((await f.read(repository)).values.workflow, false);
  assert.notEqual((await f.read(repository)).workflowFile, linked.workflowFile);
});

test("relative gitdir submodule markers scope to their containing checkout", async t => {
  const f = await fixture(t);
  const parent = await f.repository("parent");
  const child = path.join(parent, "child");
  const administration = path.join(parent, ".git", "modules", "child");
  await mkdir(child);
  await mkdir(administration, { recursive: true });
  await writeFile(path.join(child, ".git"), "gitdir: ../.git/modules/child\n");
  await f.write(parent, false);
  const nested = await f.read(child);
  assert.equal(nested.scopeRoot, child);
  assert.equal(nested.values.workflow, true);
  await f.write(child, true);
  assert.equal((await f.read(parent)).values.workflow, false);
});

test("empty non-Git workspaces use canonical cwd without creating workspace or profile files on reads", async t => {
  const f = await fixture(t);
  const first = path.join(f.root, "empty");
  const second = path.join(f.root, "other");
  await mkdir(first);
  await mkdir(second);
  const snapshot = await f.read(first);
  assert.equal(snapshot.scopeRoot, first);
  assert.equal(snapshot.values.workflow, true);
  assert.deepEqual(await readdir(f.agentDir), []);
  assert.deepEqual(await readdir(first), []);
  await f.write(first, false);
  assert.equal((await f.read(first)).values.workflow, false);
  assert.equal((await f.read(second)).values.workflow, true);
  assert.deepEqual(await readdir(first), []);
});

test("concurrent writes for different repositories preserve both masters", async t => {
  const f = await fixture(t);
  const first = await f.repository("first");
  const second = await f.repository("second");
  assert.deepEqual(await Promise.all([f.write(first, false), f.write(second, true), f.write(first, false, "review")]),
    [false, true, false]);
  assert.equal((await f.read(first)).values.workflow, false);
  assert.equal((await f.read(second)).values.workflow, true);
  assert.equal((await f.read(second)).values.review, false);
});

test("legacy master true, false and corrupt bytes are ignored and never migrated or modified", async t => {
  const f = await fixture(t);
  const repository = await f.repository("repository");
  await f.write(repository, false, "review");
  const directory = (await f.read(repository)).directory;
  const legacy = path.join(directory, "workflow.json");
  for (const bytes of ["true", "false", "{corrupt private legacy state"]) {
    await writeFile(legacy, bytes, { mode: 0o600 });
    const snapshot = await f.read(repository);
    assert.equal(snapshot.values.workflow, true);
    assert.deepEqual(snapshot.errors, {});
    assert.equal(await readFile(legacy, "utf8"), bytes);
    await assert.rejects(readFile(snapshot.workflowFile), { code: "ENOENT" });
  }
  await f.write(repository, false);
  assert.equal(await readFile(legacy, "utf8"), "{corrupt private legacy state");
});

test("missing or invalid cwd makes only master unknown and cannot create master state", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, "file");
  await writeFile(file, "not a directory");
  await f.write(undefined, false, "plan");
  for (const cwd of [undefined, "", null, 42, path.join(f.root, "missing"), file]) {
    const snapshot = await f.read(cwd);
    assert.equal(snapshot.scopeRoot, undefined);
    assert.equal(snapshot.workflowFile, undefined);
    assert.equal(snapshot.values.workflow, undefined);
    assert.equal(snapshot.values.plan, false);
    assert.deepEqual(Object.keys(snapshot.errors), ["workflow"]);
    await assert.rejects(f.write(cwd, false), /workspace directory/i);
  }
  assert.deepEqual(await readdir((await f.read(undefined)).directory), ["plan.json"]);
});

test("unsafe, unreadable or malformed Git markers never fall through to another scope", async t => {
  const f = await fixture(t);
  const repository = await f.repository("parent");
  const child = path.join(repository, "child");
  await mkdir(child);
  await f.write(repository, false, "plan");
  const marker = path.join(child, ".git");
  for (const text of ["", "unknown", "gitdir: \n", "gitdir: missing\n", "gitdir: ../.git\nextra", "x".repeat(4097)]) {
    await writeFile(marker, text);
    const snapshot = await f.read(child);
    assert.equal(snapshot.values.workflow, undefined);
    assert.equal(snapshot.values.plan, false);
    assert.deepEqual(Object.keys(snapshot.errors), ["workflow"]);
    await assert.rejects(f.write(child, false), /Git marker/);
  }
  await writeFile(marker, "gitdir: ../.git\n");
  await chmod(marker, 0o000);
  assert.equal((await f.read(child)).values.workflow, undefined);
  await chmod(marker, 0o600);
  await rm(marker);
  await symlink(path.join(repository, ".git"), marker);
  assert.equal((await f.read(child)).values.workflow, undefined);
  await assert.rejects(f.write(child, false), /Git marker/);
  await rm(marker);
  const linkedAdministration = path.join(child, "administration");
  await symlink(path.join(repository, ".git"), linkedAdministration);
  await writeFile(marker, "gitdir: administration\n");
  assert.equal((await f.read(child)).values.workflow, undefined);
  await assert.rejects(f.write(child, false), /Git marker/);
  await rm(marker);
  await mkdir(marker);
  await chmod(marker, 0o000);
  assert.equal((await f.read(child)).values.workflow, undefined);
  await chmod(marker, 0o700);
  assert.equal((await f.read(child)).scopeRoot, child);
});

test("repository ancestor and target symlinks affect only master, preserving stage values and external bytes", async t => {
  const f = await fixture(t);
  const repository = await f.repository("repository");
  await f.write(repository, false);
  await f.write(repository, false, "plan");
  const original = await f.read(repository);
  const outside = path.join(f.root, "sentinel.json");
  await writeFile(outside, "true");
  await rm(original.workflowFile);
  await symlink(outside, original.workflowFile);
  let snapshot = await f.read(repository);
  assert.equal(snapshot.values.workflow, undefined);
  assert.equal(snapshot.values.plan, false);
  assert.deepEqual(Object.keys(snapshot.errors), ["workflow"]);
  await assert.rejects(f.write(repository, false), /non-symlink/);
  assert.equal(await readFile(outside, "utf8"), "true");
  await rm(original.workflowFile);
  const local = path.dirname(original.workflowFile);
  const saved = path.join(f.root, "saved-local");
  await rename(local, saved);
  await symlink(saved, local);
  snapshot = await f.read(repository);
  assert.deepEqual(Object.keys(snapshot.errors), ["workflow"]);
  assert.equal(snapshot.values.plan, false);
  await assert.rejects(f.write(repository, false), /directory|symlink/);
  assert.deepEqual(await readdir(saved), []);
  await f.write(repository, true, "plan");
  assert.equal((await f.read(repository)).values.plan, true);
  const repositories = path.dirname(local);
  await rm(local);
  await rename(repositories, path.join(f.root, "saved-repositories"));
  await symlink(saved, repositories);
  assert.deepEqual(Object.keys((await f.read(repository)).errors), ["workflow"]);
  await assert.rejects(f.write(repository, false), /directory|symlink/);
  assert.deepEqual(await readdir(saved), []);
});

test("permissive repository storage stays unknown on reads and private on explicit writes", async t => {
  const f = await fixture(t);
  const repository = await f.repository("repository");
  await f.write(repository, false);
  await f.write(repository, false, "review");
  const local = path.dirname((await f.read(repository)).workflowFile);
  await chmod(local, 0o755);
  const snapshot = await f.read(repository);
  assert.equal(snapshot.values.workflow, undefined);
  assert.equal(snapshot.values.review, false);
  assert.match(snapshot.errors.workflow, /private/);
  await f.write(repository, false);
  assert.equal((await f.read(repository)).values.workflow, false);
});
