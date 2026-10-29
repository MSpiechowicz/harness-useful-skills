import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareStorage, workspaceMemoryPaths } from "../memory-paths.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-memory-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "profile");
  await mkdir(workspace);
  await mkdir(agentDir);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  return { root, workspace, agentDir, options: { cwd: workspace, agentDir } };
}

const invalidPaths = [
  ["missing cwd", f => ({ agentDir: f.agentDir }), /workspace cwd.*required/i],
  ["numeric cwd", f => ({ cwd: 42, agentDir: f.agentDir }), /workspace cwd.*required/i],
  ["empty profile", f => ({ cwd: f.workspace, agentDir: "" }), /profile directory.*required/i],
  ["null profile", f => ({ cwd: f.workspace, agentDir: null }), /profile directory.*required/i],
  ["missing workspace", f => ({ ...f.options, cwd: path.join(f.root, "missing") }), /cannot resolve/i],
  ["file profile", f => ({ cwd: f.workspace, agentDir: path.join(f.workspace, "main.py") }), /profile.*directory/i],
];

for (const [name, options, expected] of invalidPaths) {
  test(`invalid ${name} is rejected without creating managed state`, async t => {
    const f = await fixture(t);
    await assert.rejects(workspaceMemoryPaths(options(f)), expected);
    assert.deepEqual(await readdir(f.agentDir), []);
  });
}

test("workspace path must be a directory, not a regular source file", async t => {
  const f = await fixture(t);
  await assert.rejects(
    workspaceMemoryPaths({ cwd: path.join(f.workspace, "main.py"), agentDir: f.agentDir }),
    /workspace.*directory/i,
  );
  assert.deepEqual(await readdir(f.agentDir), []);
});

test("a symlinked profile path is refused", async t => {
  const f = await fixture(t);
  const link = path.join(f.root, "profile-link");
  await symlink(f.agentDir, link);
  await assert.rejects(workspaceMemoryPaths({ cwd: f.workspace, agentDir: link }), /symbolic links/i);
});

test("paths name the workspace folder and notes file, and nothing of the retired graph", async t => {
  const f = await fixture(t);
  const paths = await workspaceMemoryPaths(f.options);
  assert.equal(path.dirname(path.dirname(paths.directory)), path.join(paths.agentDir, "harness-useful-skills"));
  assert.match(path.basename(paths.directory), /^[0-9a-f]{64}$/);
  assert.equal(paths.notes, path.join(paths.directory, "notes.md"));
  for (const gone of ["generations", "runtime", "current", "graph", "snapshot"]) {
    assert.equal(gone in paths, false, gone);
  }
  assert.deepEqual(await readdir(f.agentDir), [], "resolving paths creates nothing");
});

test("managed storage inside the workspace is refused", async t => {
  const f = await fixture(t);
  await assert.rejects(workspaceMemoryPaths({ cwd: f.agentDir, agentDir: f.agentDir }), /outside the workspace/i);
});

for (const ancestor of ["harness-useful-skills", "memory", "workspace"]) {
  test(`managed ${ancestor} symlink cannot redirect storage`, async t => {
    const f = await fixture(t);
    const paths = await workspaceMemoryPaths(f.options);
    const targets = {
      "harness-useful-skills": path.join(f.agentDir, "harness-useful-skills"),
      memory: path.dirname(paths.directory),
      workspace: paths.directory,
    };
    const redirected = path.join(f.root, "redirected");
    await mkdir(redirected);
    await mkdir(path.dirname(targets[ancestor]), { recursive: true });
    await symlink(redirected, targets[ancestor]);
    await assert.rejects(workspaceMemoryPaths(f.options), /non-symlink directory/i);
    await assert.rejects(prepareStorage(paths), /non-symlink directory/i);
    assert.deepEqual(await readdir(redirected), []);
  });
}

test("prepareStorage creates private ancestors", async t => {
  const f = await fixture(t);
  const paths = await workspaceMemoryPaths(f.options);
  await prepareStorage(paths);
  for (const directory of [path.join(f.agentDir, "harness-useful-skills"), path.dirname(paths.directory), paths.directory]) {
    assert.equal((await stat(directory)).mode & 0o077, 0, directory);
  }
});
