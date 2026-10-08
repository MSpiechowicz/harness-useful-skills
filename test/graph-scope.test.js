import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertWorkspaceUnchanged, pinWorkspace, SCOPE_COVERS_HOME, SCOPE_HOME_UNKNOWN, SCOPE_UNREADABLE, sourceScopeError, workspaceMountBlocker,
  workspaceScopeBlocker,
} from "../graph-scope.js";
import { mountLine } from "./helpers/graph-fixture.js";

async function layout(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-graph-scope-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const repo = path.join(home, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "main.py"), "def main(): pass\n");
  const system = { homedir: () => home, userInfo: () => ({ homedir: home }), readMountInfo: async () => mountLine("/") };
  return { root, home, repo, system, scope: { system } };
}

function escapeMountField(value) {
  return value.replace(/[ \t\n\\]/g, (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`);
}

/** One mountinfo line with an explicit filesystem type, source, and super options. */
function mountEntry(mountPoint, fstype, source, options = "rw") {
  return `91 1 0:51 / ${escapeMountField(mountPoint)} rw,relatime - ${fstype} ${escapeMountField(source)} ${options}\n`;
}

/** A stat that reports `target`'s identity for `file`, simulating a bind mount. */
function aliasStat(file, target) {
  return (candidate, options) => stat(candidate === file ? target : candidate, options);
}

test("workspaces that are, contain, or alias a home directory or the filesystem root are refused", async t => {
  const f = await layout(t);

  assert.equal(await workspaceScopeBlocker([f.repo], f.scope), undefined);
  assert.equal(await workspaceScopeBlocker([f.home], f.scope), SCOPE_COVERS_HOME);
  assert.equal(await workspaceScopeBlocker([f.root], f.scope), SCOPE_COVERS_HOME);
  assert.equal(await workspaceScopeBlocker(["/"], f.scope), SCOPE_COVERS_HOME);
  assert.equal(await workspaceScopeBlocker([f.repo], { ...f.scope, home: f.repo }), SCOPE_COVERS_HOME);

  const accountOnly = { ...f.system, homedir: () => path.join(f.root, "elsewhere") };
  assert.equal(await workspaceScopeBlocker([f.home], { system: accountOnly }), SCOPE_COVERS_HOME);

  for (const target of [f.home, f.root, "/"]) {
    const system = { ...f.system, stat: aliasStat(f.repo, target) };
    assert.equal(await workspaceScopeBlocker([f.repo], { system }), SCOPE_COVERS_HOME, target);
  }
});

test("an empty, relative, or throwing $HOME and an unreadable workspace are refused", async t => {
  const f = await layout(t);
  const homes = [() => "", () => "relative/home", () => { throw new Error("no home"); }];

  for (const homedir of homes) {
    assert.equal(await workspaceScopeBlocker([f.repo], { system: { ...f.system, homedir } }), SCOPE_HOME_UNKNOWN);
    await assert.rejects(pinWorkspace(f.repo, { system: { ...f.system, homedir } }), new RegExp(SCOPE_HOME_UNKNOWN));
  }

  const noAccount = { ...f.system, userInfo: () => { throw new Error("no passwd entry"); } };
  assert.equal(await workspaceScopeBlocker([f.repo], { system: noAccount }), undefined);

  const unreadable = { ...f.system, stat: async (file, options) => {
    if (file === f.repo) {
      throw new Error("EACCES");
    }

    return stat(file, options);
  } };
  assert.equal(await workspaceScopeBlocker([f.repo], { system: unreadable }), SCOPE_UNREADABLE);
});

test("mount checks refuse unreadable, malformed, or missing Linux tables and skip platforms without one", async t => {
  const f = await layout(t);
  const check = (readMountInfo, platform = "linux") => workspaceMountBlocker("/repo", { system: { ...f.system, readMountInfo, platform } });

  assert.equal(await check(async () => undefined, "darwin"), undefined);
  assert.equal(await check(async () => undefined), "mount table cannot be checked: /proc/self/mountinfo is missing");
  assert.equal(await check(async () => mountLine("/repo/mnt")), "workspace contains a nested mount at /repo/mnt");
  assert.match(await check(async () => { throw new Error("EACCES"); }), /^mount table cannot be checked: EACCES$/);
  assert.match(await check(async () => "garbage\n"), /^mount table cannot be checked: Mount table line 1 is malformed\.$/);
  assert.equal(await check(async () => ""), "mount table does not list the workspace's mount (for example a masked /proc or a chroot)");
  assert.equal(await workspaceMountBlocker("/repo", { system: { ...f.system, homedir: () => "" } }), SCOPE_HOME_UNKNOWN);
});

test("mount backing checks protect the configured, account, and canonical home paths", async t => {
  const f = await layout(t);
  const alias = path.join(f.root, "alias");
  await symlink(f.home, alias);
  const overlay = layer => async () => mountEntry("/ws", "overlay", "overlay", `lowerdir=${layer},upperdir=/srv/u,workdir=/srv/w`);
  const check = (system, home) => workspaceMountBlocker("/ws/repo", { home, system: { ...f.system, ...system } });
  const refused = "workspace is on an overlay mount at /ws whose layers include a home directory";

  assert.equal(await check({ readMountInfo: overlay(f.home), homedir: () => alias }), refused);
  assert.equal(await check({ readMountInfo: overlay(alias) }, alias), refused);
  assert.equal(await check({ readMountInfo: overlay(f.home), homedir: () => path.join(f.root, "x"), userInfo: () => ({ homedir: f.home }) }), refused);
  assert.equal(await check({ readMountInfo: overlay(path.join(f.root, "elsewhere")) }), undefined);

  // Without the alias configured, the symlink layer is still traced to the home it resolves to.
  assert.equal(await check({ readMountInfo: overlay(alias) }), refused);

  // A layer that reports the identity of a home, its parent, or `/` behaves like a bind mount of it.
  const layer = path.join(f.root, "layer");
  await mkdir(layer);
  assert.equal(await check({ readMountInfo: overlay(layer) }), undefined);
  for (const target of [f.home, f.root, "/"]) {
    assert.equal(await check({ readMountInfo: overlay(layer), stat: aliasStat(layer, target) }), refused, target);
  }
});

test("a pinned workspace detects a swapped directory or a changed path", async t => {
  const f = await layout(t);
  const pin = await pinWorkspace(f.repo, f.scope);
  await assertWorkspaceUnchanged(pin, f.scope);

  await rename(f.repo, `${f.repo}-old`);
  await mkdir(f.repo);
  await assert.rejects(assertWorkspaceUnchanged(pin, f.scope), /Workspace directory changed during the graph build/);

  await rm(f.repo, { recursive: true });
  await assert.rejects(assertWorkspaceUnchanged(pin, f.scope), /cannot be re-checked/);
});

test("sources on another device or behind a bind-mounted home are refused", async t => {
  const f = await layout(t);
  const source = path.join(f.repo, "src", "main.py");
  const pin = await pinWorkspace(f.repo, f.scope);

  assert.equal(await sourceScopeError(source, pin, f.scope), undefined);
  assert.match(await sourceScopeError(path.join(f.root, "x.py"), pin, f.scope), /resolves outside the workspace/);
  assert.match(await sourceScopeError(f.repo, pin, f.scope), /resolves outside the workspace/);

  const otherDevice = async (file, options) => {
    const details = await stat(file, options);
    return file === source ? { dev: details.dev + 1n, ino: details.ino } : details;
  };
  const devicePin = await pinWorkspace(f.repo, f.scope);
  const deviceError = await sourceScopeError(source, devicePin, { system: { stat: otherDevice } });
  assert.equal(deviceError, "Graph node source file src/main.py lies on a different device than the workspace at src/main.py (a nested mount or btrfs subvolume).");

  const homeMount = { stat: aliasStat(path.join(f.repo, "src"), f.home) };
  const homePin = await pinWorkspace(f.repo, f.scope);
  assert.match(await sourceScopeError(source, homePin, { system: homeMount }), /passes through a mount of a protected home directory at src\.$/);

  const failing = { stat: async () => { throw new Error("EIO"); } };
  const failingPin = await pinWorkspace(f.repo, f.scope);
  assert.match(await sourceScopeError(source, failingPin, { system: failing }), /cannot be checked at src: EIO\.$/);
});

test("checked source directories are cached for the rest of one build", async t => {
  const f = await layout(t);
  await writeFile(path.join(f.repo, "src", "util.py"), "x = 1\n");
  const pin = await pinWorkspace(f.repo, f.scope);
  const seen = [];
  const counting = { stat: (file, options) => {
    seen.push(path.relative(f.repo, file));
    return stat(file, options);
  } };

  assert.equal(await sourceScopeError(path.join(f.repo, "src", "main.py"), pin, { system: counting }), undefined);
  assert.equal(await sourceScopeError(path.join(f.repo, "src", "util.py"), pin, { system: counting }), undefined);
  assert.deepEqual(seen, ["src", "src/main.py", "src/util.py"]);
});
