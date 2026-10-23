import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateDataDirectory, migrateDirectory } from "../data-migration.js";
import { LEGACY_DATA_DIRECTORY } from "../legacy-names.js";
import { DATA_DIRECTORY } from "../names.js";

function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "us-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, LEGACY_DATA_DIRECTORY);
  const current = path.join(root, DATA_DIRECTORY);
  const put = (base, rel, text, mode) => {
    const file = path.join(base, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (mode) chmodSync(file, mode);
    return file;
  };
  return { root, legacy, current, put };
}

function tree(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${rel}/`, ...tree(path.join(directory, entry.name), rel)] : [rel];
  });
}

test("a legacy data directory moves to the current name and the old one disappears", t => {
  const f = sandbox(t);
  f.put(f.legacy, "models.yml", "modelRoles:\n  review: inherit\n");
  f.put(f.legacy, "workflow-settings/plan.json", "{\"enabled\":false}", 0o600);
  f.put(f.legacy, "memory/abc/notes.md", "kept\n");

  const result = migrateDataDirectory(f.root);

  assert.deepEqual(result, { kept: [] });
  assert.equal(existsSync(f.legacy), false);
  assert.deepEqual(tree(f.current), ["memory/", "memory/abc/", "memory/abc/notes.md", "models.yml", "workflow-settings/", "workflow-settings/plan.json"]);
  assert.equal(readFileSync(path.join(f.current, "memory", "abc", "notes.md"), "utf8"), "kept\n");
  assert.equal(statSync(path.join(f.current, "workflow-settings", "plan.json")).mode & 0o777, 0o600);
});

test("directory modes are preserved so private stores stay private", t => {
  const f = sandbox(t);
  f.put(f.legacy, "memory/a/file", "x");
  chmodSync(f.legacy, 0o700);
  chmodSync(path.join(f.legacy, "memory"), 0o700);

  migrateDataDirectory(f.root);

  assert.equal(statSync(f.current).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(f.current, "memory")).mode & 0o777, 0o700);
});

test("nothing happens when there is no legacy directory", t => {
  const f = sandbox(t);
  assert.deepEqual(migrateDataDirectory(f.root), { kept: [] });
  assert.equal(existsSync(f.current), false);
});

test("a file that differs from the one in the new place stays in the old place, everything else moves", t => {
  const f = sandbox(t);
  f.put(f.legacy, "models.yml", "old edit\n");
  f.put(f.legacy, "memory/only-old.md", "old\n");
  f.put(f.current, "models.yml", "new edit\n");
  f.put(f.current, "memory/only-new.md", "new\n");

  const result = migrateDataDirectory(f.root);

  assert.deepEqual(result.kept, [path.join(f.legacy, "models.yml")]);
  assert.equal(readFileSync(path.join(f.legacy, "models.yml"), "utf8"), "old edit\n");
  assert.equal(readFileSync(path.join(f.current, "models.yml"), "utf8"), "new edit\n");
  assert.deepEqual(tree(f.current), ["memory/", "memory/only-new.md", "memory/only-old.md", "models.yml"]);
  assert.deepEqual(tree(f.legacy), ["models.yml"]);
});

test("an identical file in both places is just removed from the old place", t => {
  const f = sandbox(t);
  f.put(f.legacy, "models.yml", "same\n");
  f.put(f.current, "models.yml", "same\n");

  assert.deepEqual(migrateDataDirectory(f.root), { kept: [] });
  assert.equal(existsSync(f.legacy), false);
  assert.equal(readFileSync(path.join(f.current, "models.yml"), "utf8"), "same\n");
});

test("the dependency environment is dropped, not copied, because it holds absolute paths", t => {
  const f = sandbox(t);
  f.put(f.legacy, "dependencies/abc/venv/bin/python", "#!/old/path\n");
  f.put(f.legacy, "memory/m.md", "memory\n");

  migrateDataDirectory(f.root);

  assert.deepEqual(tree(f.current), ["memory/", "memory/m.md"]);
  assert.equal(existsSync(f.legacy), false);
});

test("the dependency environment is kept while a conflicting file keeps the old directory", t => {
  const f = sandbox(t);
  f.put(f.legacy, "dependencies/abc/marker", "cache\n");
  f.put(f.legacy, "models.yml", "old\n");
  f.put(f.current, "models.yml", "new\n");

  migrateDataDirectory(f.root);

  assert.deepEqual(tree(f.legacy), ["dependencies/", "dependencies/abc/", "dependencies/abc/marker", "models.yml"]);
});

test("symbolic links are neither followed nor removed", t => {
  const f = sandbox(t);
  const outside = path.join(f.root, "outside.txt");
  writeFileSync(outside, "outside\n");
  f.put(f.legacy, "memory/a.md", "a\n");
  symlinkSync(outside, path.join(f.legacy, "link"));

  const result = migrateDataDirectory(f.root);

  assert.deepEqual(result.kept, [path.join(f.legacy, "link")]);
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
  assert.deepEqual(tree(f.current), ["memory/", "memory/a.md"]);
});

test("a legacy path that is a symbolic link or a file is left alone", t => {
  const f = sandbox(t);
  const elsewhere = path.join(f.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "x"), "x");
  symlinkSync(elsewhere, f.legacy);

  assert.deepEqual(migrateDataDirectory(f.root), { kept: [f.legacy] });
  assert.equal(existsSync(path.join(elsewhere, "x")), true);
  assert.equal(existsSync(f.current), false);
});

test("a current path that is a file keeps the whole legacy directory", t => {
  const f = sandbox(t);
  f.put(f.legacy, "models.yml", "old\n");
  writeFileSync(f.current, "i am a file\n");

  const result = migrateDataDirectory(f.root);

  assert.deepEqual(result.kept, [f.legacy]);
  assert.equal(readFileSync(path.join(f.legacy, "models.yml"), "utf8"), "old\n");
  assert.equal(readFileSync(f.current, "utf8"), "i am a file\n");
});

test("running it twice is harmless", t => {
  const f = sandbox(t);
  f.put(f.legacy, "memory/a.md", "a\n");

  migrateDataDirectory(f.root);
  const again = migrateDataDirectory(f.root);

  assert.deepEqual(again, { kept: [] });
  assert.deepEqual(tree(f.current), ["memory/", "memory/a.md"]);
});

test("migrateDirectory moves between arbitrary locations and creates the parent", t => {
  const f = sandbox(t);
  const from = path.join(f.root, "old-data");
  const to = path.join(f.root, "deep", "new-data");
  f.put(from, "a/b.txt", "b\n");

  assert.deepEqual(migrateDirectory(from, to), { kept: [] });
  assert.equal(readFileSync(path.join(to, "a", "b.txt"), "utf8"), "b\n");
  assert.equal(existsSync(from), false);
});

test("an OMP profile's memory and settings move when the profile is first used under the new name", async t => {
  const { createHash } = await import("node:crypto");
  const { realpathSync } = await import("node:fs");
  const { workspaceMemoryPaths } = await import("../graphify.js");
  const { readWorkflowSettings } = await import("../workflow-settings.js");

  const f = sandbox(t);
  const profile = realpathSync(f.root);
  const workspace = path.join(profile, "project");
  mkdirSync(workspace);
  const hash = createHash("sha256").update(realpathSync(workspace)).digest("hex");
  f.put(f.legacy, `memory/${hash}/notes.md`, "saved before the rename\n");
  f.put(f.legacy, "workflow-settings/review.json", "false\n", 0o600);
  for (const directory of [f.legacy, "workflow-settings", "memory", `memory/${hash}`]) chmodSync(path.resolve(f.legacy, directory), 0o700);

  const settings = await readWorkflowSettings({ agentDir: profile, cwd: workspace });
  assert.equal(settings.values.review, false);

  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir: profile });
  assert.equal(paths.directory, path.join(profile, DATA_DIRECTORY, "memory", hash));
  assert.equal(readFileSync(path.join(paths.directory, "notes.md"), "utf8"), "saved before the rename\n");
  assert.equal(existsSync(f.legacy), false);
});
