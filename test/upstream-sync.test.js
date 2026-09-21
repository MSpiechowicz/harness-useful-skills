import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runUpstream } from "../upstream-sync.js";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 15000 })).stdout.trim();
}
async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function commit(root) {
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}
async function init(root) {
  await mkdir(root, { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "commit.gpgsign", "false");
}
const document = "# Workflow\n\nOriginal introduction.\n\nMiddle paragraph.\n\nOriginal ending.\n";
async function fixture(t, ours = document) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ecc-sync-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const upstream = path.join(home, "upstream");
  const root = path.join(home, "port");
  await init(upstream);
  await put(upstream, "skills/example/SKILL.md", document);
  await put(upstream, "package.json", JSON.stringify({ version: "1.0.0" }));
  const base = await commit(upstream);
  await init(root);
  await put(root, "package.json", JSON.stringify({ name: "oh-my-pi-useful-skills", omp: { extensions: ["./extension.js"] } }));
  await put(root, "skills/example/SKILL.md", ours);
  await put(root, "skills/approve-changes/SKILL.md", "Local-only skill\n");
  await put(root, "ecc-upstream.json", JSON.stringify({ repository: "affaan-m/ECC", revision: base, excludedPaths: [] }, null, 2) + "\n");
  await commit(root);
  return { root, upstream, base, options: { root, upstreamUrl: upstream, ref: "main" } };
}

test("check is read-only and sync merges disjoint local and upstream edits", async (t) => {
  const f = await fixture(t, document.replace("Original introduction.", "OMP introduction."));
  await put(f.upstream, "skills/example/SKILL.md", document.replace("Original ending.", "Updated upstream ending."));
  await put(f.upstream, "commands/new.md", "# New upstream command\n");
  const target = await commit(f.upstream);
  await runUpstream("check", f.options);
  assert.equal(await git(f.root, "status", "--porcelain"), "");
  const report = await runUpstream("sync", f.options);
  assert.equal(report.applied, true);
  assert.equal(await readFile(path.join(f.root, "skills/example/SKILL.md"), "utf8"),
    document.replace("Original introduction.", "OMP introduction.").replace("Original ending.", "Updated upstream ending."));
  assert.equal(await readFile(path.join(f.root, "commands/new.md"), "utf8"), "# New upstream command\n");
  assert.equal(await readFile(path.join(f.root, "skills/approve-changes/SKILL.md"), "utf8"), "Local-only skill\n");
  assert.equal(JSON.parse(await readFile(path.join(f.root, "ecc-upstream.json"), "utf8")).revision, target);
});

test("overlapping edits reject the whole batch without advancing provenance", async (t) => {
  const f = await fixture(t, document.replace("Original introduction.", "OMP introduction."));
  await put(f.upstream, "skills/example/SKILL.md", document.replace("Original introduction.", "Upstream introduction."));
  await put(f.upstream, "commands/new.md", "# Should not be applied\n");
  await commit(f.upstream);
  const report = await runUpstream("sync", f.options);
  assert.equal(report.applied, false);
  assert.ok(report.conflicts.length > 0);
  assert.equal(await git(f.root, "status", "--porcelain"), "");
  assert.equal(JSON.parse(await readFile(path.join(f.root, "ecc-upstream.json"), "utf8")).revision, f.base);
});

test("sync refuses dirty checkouts and unsafe refs", async (t) => {
  const f = await fixture(t);
  await put(f.root, "untracked.txt", "user work\n");
  await assert.rejects(runUpstream("sync", f.options), /clean|dirty|uncommitted/i);
  await assert.rejects(runUpstream("check", { ...f.options, ref: "--upload-pack=evil" }), /ref|invalid/i);
  assert.equal(await readFile(path.join(f.root, "untracked.txt"), "utf8"), "user work\n");
});

test("sync never follows a locally committed symlink outside the checkout", async (t) => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.root), "outside");
  await mkdir(outside);
  await put(outside, "new.md", "outside must remain untouched\n");
  await symlink(outside, path.join(f.root, "commands"));
  await commit(f.root);
  await put(f.upstream, "commands/new.md", "# upstream\n");
  await commit(f.upstream);
  await assert.rejects(runUpstream("sync", f.options), /symlink|symbolic|unsafe/i);
  assert.equal(await readFile(path.join(outside, "new.md"), "utf8"), "outside must remain untouched\n");
  assert.equal(await git(f.root, "status", "--porcelain"), "");
});

test("upstream deletion conflicts with a locally adapted document", async (t) => {
  const f = await fixture(t, document.replace("Middle paragraph.", "OMP adaptation."));
  await rm(path.join(f.upstream, "skills/example/SKILL.md"));
  await commit(f.upstream);
  const report = await runUpstream("sync", f.options);
  assert.equal(report.applied, false);
  assert.ok(report.conflicts.length > 0);
  assert.equal(await git(f.root, "status", "--porcelain"), "");
});

test("upstream addition cannot overwrite a locally owned document", async (t) => {
  const f = await fixture(t);
  await put(f.root, "commands/custom.md", "Our custom command\n");
  await commit(f.root);
  await put(f.upstream, "commands/custom.md", "Unrelated upstream command\n");
  await commit(f.upstream);
  const report = await runUpstream("sync", f.options);
  assert.equal(report.applied, false);
  assert.ok(report.conflicts.length > 0);
  assert.equal(await readFile(path.join(f.root, "commands/custom.md"), "utf8"), "Our custom command\n");
});

test("excluded OMP replacements stay local while other Markdown syncs", async (t) => {
  const f = await fixture(t, document.replace("Middle paragraph.", "Native replacement."));
  await put(f.root, "ecc-upstream.json", JSON.stringify({
    repository: "affaan-m/ECC", revision: f.base, excludedPaths: ["skills/example/SKILL.md"],
  }, null, 2) + "\n");
  await commit(f.root);
  await put(f.upstream, "skills/example/SKILL.md", "Entirely different upstream instructions\n");
  await put(f.upstream, "commands/new.md", "# Added\n");
  await commit(f.upstream);
  await runUpstream("sync", f.options);
  assert.equal(await readFile(path.join(f.root, "skills/example/SKILL.md"), "utf8"),
    document.replace("Middle paragraph.", "Native replacement."));
  assert.equal(await readFile(path.join(f.root, "commands/new.md"), "utf8"), "# Added\n");
});
