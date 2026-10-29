import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateStageFiles, retireGraphifyData } from "../graphify-retirement.js";
import { workspaceMemoryPaths } from "../memory-paths.js";
import { readWorkflowSettings, writeWorkflowSetting } from "../workflow-settings.js";

const HASH = "a".repeat(64);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-retire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile");
  const base = path.join(profile, "harness-useful-skills");
  await mkdir(base, { recursive: true, mode: 0o700 });
  return { root, profile, base, memory: path.join(base, "memory"), settings: path.join(base, "workflow-settings") };
}

async function put(file, text = "x") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function seedGraphify(f, hash = HASH) {
  const directory = path.join(f.memory, hash);
  await put(path.join(f.base, "dependencies", "lock", "venv", "bin", "python"));
  await put(path.join(directory, "generations", "g1", "graph.json"), "{}");
  await put(path.join(directory, "runtime", "home", "file"));
  await put(path.join(directory, "current.json"), "{}");
  return directory;
}

test("removes the dependency environment, generations, runtime and pointer, then the empty hash folder", async t => {
  const f = await fixture(t);
  const directory = await seedGraphify(f);
  assert.equal(await retireGraphifyData(f.profile), true);
  assert.equal(existsSync(path.join(f.base, "dependencies")), false);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(await readdir(f.memory), []);
});

test("facts and notes survive and keep their folder", async t => {
  const f = await fixture(t);
  const directory = await seedGraphify(f);
  await put(path.join(directory, "claude", "00001.json"), '{"content":"fact"}');
  await put(path.join(directory, "notes.md"), "note\n");
  await retireGraphifyData(f.profile);
  assert.equal(readFileSync(path.join(directory, "claude", "00001.json"), "utf8"), '{"content":"fact"}');
  assert.equal(readFileSync(path.join(directory, "notes.md"), "utf8"), "note\n");
  assert.deepEqual((await readdir(directory)).sort(), ["claude", "notes.md"]);
});

test("a second run changes nothing", async t => {
  const f = await fixture(t);
  const directory = await seedGraphify(f);
  await put(path.join(directory, "notes.md"), "note\n");
  assert.equal(await retireGraphifyData(f.profile), true);
  assert.equal(await retireGraphifyData(f.profile), false);
  assert.deepEqual(await readdir(directory), ["notes.md"]);
});

test("a symlinked dependencies directory is not followed or removed", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "keep.txt"));
  await symlink(outside, path.join(f.base, "dependencies"));
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(path.join(outside, "keep.txt")), true);
  assert.equal((await lstat(path.join(f.base, "dependencies"))).isSymbolicLink(), true);
});

test("a symlinked generations folder or pointer is left alone and keeps the hash folder", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "keep.txt"));
  const directory = path.join(f.memory, HASH);
  await mkdir(directory, { recursive: true });
  await symlink(outside, path.join(directory, "generations"));
  await symlink(path.join(outside, "keep.txt"), path.join(directory, "current.json"));
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(path.join(outside, "keep.txt")), true);
  assert.deepEqual((await readdir(directory)).sort(), ["current.json", "generations"]);
});

test("links inside a removed tree are unlinked, never followed", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "keep.txt"));
  const directory = await seedGraphify(f);
  await symlink(outside, path.join(directory, "runtime", "link"));
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(path.join(outside, "keep.txt")), true);
  assert.equal(existsSync(path.join(directory, "runtime")), false);
});

test("a symlinked memory folder is not entered", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, HASH, "generations", "keep.txt"));
  await symlink(outside, f.memory);
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(path.join(outside, HASH, "generations", "keep.txt")), true);
});

test("folders whose names are not 64 hex digits are untouched", async t => {
  const f = await fixture(t);
  for (const name of ["not-a-hash", "A".repeat(64), "a".repeat(63), "a".repeat(65), "extra"]) {
    await put(path.join(f.memory, name, "generations", "keep.txt"));
    await put(path.join(f.memory, name, "current.json"));
  }
  await retireGraphifyData(f.profile);
  for (const name of await readdir(f.memory)) {
    assert.equal(existsSync(path.join(f.memory, name, "generations", "keep.txt")), true, name);
    assert.equal(existsSync(path.join(f.memory, name, "current.json")), true, name);
  }
});

test("other names inside a workspace folder are untouched", async t => {
  const f = await fixture(t);
  const directory = await seedGraphify(f);
  await put(path.join(directory, "runtime-extra", "keep.txt"));
  await put(path.join(directory, "dependencies", "keep.txt"));
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(path.join(directory, "runtime-extra", "keep.txt")), true);
  assert.equal(existsSync(path.join(directory, "dependencies", "keep.txt")), true);
});

test("a profile without Harness Skills data, or with a symlinked data directory, is a no-op", async t => {
  const f = await fixture(t);
  await rm(f.base, { recursive: true });
  assert.equal(await retireGraphifyData(f.profile), false);
  assert.equal(await retireGraphifyData(path.join(f.root, "missing")), false);

  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "dependencies", "keep.txt"));
  await symlink(outside, f.base);
  assert.equal(await retireGraphifyData(f.profile), false);
  assert.equal(existsSync(path.join(outside, "dependencies", "keep.txt")), true);
});

test("workspaceMemoryPaths retires old data for every workspace of the profile", async t => {
  const f = await fixture(t);
  const workspace = path.join(f.root, "workspace");
  await mkdir(workspace);
  const directory = await seedGraphify(f);
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir: f.profile, retire: true });
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(path.join(f.base, "dependencies")), false);
  assert.equal(paths.agentDir, f.profile);
});

test("never throws on an unreadable layout", async t => {
  const f = await fixture(t);
  await writeFile(f.memory, "a file where a folder belongs");
  await put(path.join(f.base, "dependencies", "x"));
  assert.equal(await retireGraphifyData(f.profile), true);
});

async function stageFixture(t) {
  const f = await fixture(t);
  await mkdir(f.settings, { recursive: true, mode: 0o700 });
  return { ...f, legacy: path.join(f.settings, "graphify-memory.json"), current: path.join(f.settings, "code-graph.json") };
}

test("stage migration: a legacy-only value moves to code-graph.json (0600) and the legacy file goes", async t => {
  const f = await stageFixture(t);
  await writeFile(f.legacy, "false\n");
  assert.equal(await migrateStageFiles(f.settings), true);
  assert.equal(JSON.parse(await readFile(f.current, "utf8")), false);
  assert.equal(statSync(f.current).mode & 0o777, 0o600);
  assert.equal(existsSync(f.legacy), false);
  assert.deepEqual((await readdir(f.settings)).sort(), ["code-graph.json"]);
  assert.equal(await migrateStageFiles(f.settings), false);
});

test("stage migration: when both exist the new value wins and the legacy file goes", async t => {
  const f = await stageFixture(t);
  await writeFile(f.legacy, "false");
  await writeFile(f.current, "true");
  await migrateStageFiles(f.settings);
  assert.equal(JSON.parse(await readFile(f.current, "utf8")), true);
  assert.equal(existsSync(f.legacy), false);
});

test("stage migration: invalid legacy content is left in place and nothing is created", async t => {
  const f = await stageFixture(t);
  for (const text of ["{not json", '"yes"', "1", "null", "x".repeat(5000)]) {
    await writeFile(f.legacy, text);
    assert.equal(await migrateStageFiles(f.settings), false, text.slice(0, 12));
    assert.equal(await readFile(f.legacy, "utf8"), text);
    assert.equal(existsSync(f.current), false);
  }
});

test("stage migration: a symlinked legacy file is not followed or removed", async t => {
  const f = await stageFixture(t);
  const target = path.join(f.root, "target.json");
  await writeFile(target, "false");
  await symlink(target, f.legacy);
  assert.equal(await migrateStageFiles(f.settings), false);
  assert.equal((await lstat(f.legacy)).isSymbolicLink(), true);
  assert.equal(existsSync(f.current), false);
  assert.equal(await readFile(target, "utf8"), "false");
});

test("stage migration: a missing directory is a no-op", async t => {
  const f = await fixture(t);
  assert.equal(await migrateStageFiles(path.join(f.root, "nowhere")), false);
});

test("retirement also migrates the stage file, and reading falls back to the legacy file before then", async t => {
  const f = await stageFixture(t);
  const workspace = path.join(f.root, "workspace");
  await mkdir(workspace);
  await writeFile(f.legacy, "false");

  const before = await readWorkflowSettings({ agentDir: f.profile, cwd: workspace });
  assert.equal(before.values["code-graph"], false);
  assert.equal(before.sources["code-graph"], "file");

  await retireGraphifyData(f.profile);
  assert.equal(existsSync(f.legacy), false);
  const after = await readWorkflowSettings({ agentDir: f.profile, cwd: workspace });
  assert.equal(after.values["code-graph"], false);

  await writeWorkflowSetting({ agentDir: f.profile, cwd: workspace, key: "code-graph", enabled: true });
  assert.equal((await readWorkflowSettings({ agentDir: f.profile, cwd: workspace })).values["code-graph"], true);
});

test("an invalid legacy stage file is an error for code-graph until it is replaced", async t => {
  const f = await stageFixture(t);
  const workspace = path.join(f.root, "workspace");
  await mkdir(workspace);
  await writeFile(f.legacy, "nope");
  const snapshot = await readWorkflowSettings({ agentDir: f.profile, cwd: workspace });
  assert.equal(snapshot.values["code-graph"], undefined);
  assert.equal(snapshot.sources["code-graph"], "error");
});

test("read-only callers and doctor --check leave Graphify data and the legacy stage file untouched", async t => {
  const f = await stageFixture(t);
  const workspace = path.join(f.root, "workspace");
  await mkdir(workspace);
  const directory = await seedGraphify(f);
  await writeFile(f.legacy, "false\n");

  const { createLocalFacts } = await import("../local-facts.js");
  const host = { label: "Test", backend: "test", directory: "test-facts" };
  const facts = createLocalFacts({ cwd: workspace, agentDir: f.profile, host });
  await workspaceMemoryPaths({ cwd: workspace, agentDir: f.profile });
  await facts.inspect().catch(() => {});
  await facts.status().catch(() => {});
  await facts.search("x").catch(() => {});

  assert.equal(existsSync(path.join(directory, "generations", "g1", "graph.json")), true);
  assert.equal(existsSync(path.join(f.base, "dependencies")), true);
  assert.equal(existsSync(f.legacy), true);
  assert.equal(existsSync(f.current), false);
});

test("an empty hash folder made by another process survives retirement", async t => {
  const f = await fixture(t);
  const empty = path.join(f.memory, "b".repeat(64));
  await mkdir(empty, { recursive: true });
  await seedGraphify(f);
  await retireGraphifyData(f.profile);
  assert.equal(existsSync(empty), true);
  assert.equal(existsSync(path.join(f.memory, HASH)), false);
});

test("a symlinked workflow-settings folder leaves its target and the legacy file untouched", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside-settings");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(path.join(outside, "graphify-memory.json"), "false\n");
  await symlink(outside, f.settings);
  await retireGraphifyData(f.profile);
  assert.deepEqual(await readdir(outside), ["graphify-memory.json"]);
  assert.equal(readFileSync(path.join(outside, "graphify-memory.json"), "utf8"), "false\n");
});

test("a legacy stage file larger than the limit is ignored without being read whole", async t => {
  const f = await stageFixture(t);
  await writeFile(f.legacy, `true${" ".repeat(5000)}`);
  assert.equal(await migrateStageFiles(f.settings), false);
  assert.equal(existsSync(f.legacy), true);
  assert.equal(existsSync(f.current), false);
});
