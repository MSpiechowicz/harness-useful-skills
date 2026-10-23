import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  buildRelease,
  bsdListingStub,
  directory,
  rawArchiveFile,
  runInstaller,
  shims,
  skip,
  tarListingStub,
} from "./helpers/install-script-fixture.js";

test("a malformed HARNESS_SKILLS_VERSION is refused before any download", { skip }, async () => {
  for (const version of ["1.2", "v1.2.3/../../x", "v1.2.3-rc1", "v1.2.3?x=1", "1.2.3\n", "$(id)"]) {
    const outcome = await runInstaller({ env: { HARNESS_SKILLS_VERSION: version } });
    assert.notEqual(outcome.status, 0, version);
    assert.match(outcome.stderr, /unexpected version/, version);
    assert.deepEqual(outcome.downloads, [], version);
    assert.deepEqual(outcome.leftovers, [], version);
  }
});

test("Node.js older than 22 is refused before any download", { skip }, async () => {
  const outcome = await runInstaller({ env: { FAKE_NODE_VERSION: "20.11.1", HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /Harness Skills needs Node\.js 22 or newer, but found 20\.11\.1/);
  assert.deepEqual(outcome.downloads, []);
});

test("installs from the release tag and runs its installer for OpenCode in the user scope", { skip }, async () => {
  const { archive, top } = await buildRelease();
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "1.2.3" } });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(outcome.downloads, ["https://codeload.github.com/MSpiechowicz/harness-useful-skills/tar.gz/refs/tags/v1.2.3"]);
  assert.equal(outcome.recorded.argv.length, 6);
  assert.equal(path.basename(outcome.recorded.argv[0]), "useful-skills");
  assert.equal(path.basename(path.dirname(outcome.recorded.argv[0])), top);
  assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
  assert.equal(await realpath(outcome.recorded.cwd), await realpath(outcome.home));
  assert.match(outcome.stdout, /Restart OpenCode to load Harness Skills\./);
  assert.deepEqual(outcome.leftovers, []);
});

test("without a version it resolves the latest release through the GitHub API", { skip }, async () => {
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, api: { tag_name: "v1.2.3", name: "1.2.3" } });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(outcome.downloads, [
    "https://api.github.com/repos/MSpiechowicz/harness-useful-skills/releases/latest",
    "https://codeload.github.com/MSpiechowicz/harness-useful-skills/tar.gz/refs/tags/v1.2.3",
  ]);
  assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
});

test("a failed release lookup suggests HARNESS_SKILLS_VERSION", { skip }, async () => {
  const outcome = await runInstaller({ api: {}, env: { STUB_API_FAIL: "1" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /HARNESS_SKILLS_VERSION/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("a latest release with an unusable tag is refused without a download", { skip }, async () => {
  for (const api of [{ tag_name: "main" }, { tag_name: "v1.2.3/../x" }, { tag_name: 3 }, {}, "not json"]) {
    const outcome = await runInstaller({ api });
    assert.notEqual(outcome.status, 0, JSON.stringify(api));
    assert.match(outcome.stderr, /HARNESS_SKILLS_VERSION/);
    assert.equal(outcome.downloads.length, 1, "only the API was asked");
    assert.deepEqual(outcome.leftovers, []);
  }
});

test("an archive with a symlink is refused and nothing runs", { skip }, async () => {
  const { archive } = await buildRelease({ extra: (root) => symlink("/etc/passwd", path.join(root, "link")) });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /not a plain file or directory|contains a link/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("an archive with a hard link is refused", { skip }, async () => {
  const { archive } = await buildRelease({ extra: (root) => link(path.join(root, "package.json"), path.join(root, "again.json")) });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("an archive with two top-level directories is refused", { skip }, async () => {
  const { archive } = await buildRelease({ extra: (_root, tree) => mkdir(path.join(tree, "other")).then(() => writeFile(path.join(tree, "other", "x"), "x")) });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /exactly one top-level directory/);
  assert.equal(outcome.recorded, null);
});

test("an archive that is not a tarball is refused", { skip }, async () => {
  const work = await directory("junk");
  const archive = path.join(work, "junk.tar.gz");
  await writeFile(archive, "this is not an archive");
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /not a valid/);
  assert.deepEqual(outcome.leftovers, []);
});

test("a failed download is reported and leaves nothing behind", { skip }, async () => {
  const outcome = await runInstaller({ env: { HARNESS_SKILLS_VERSION: "v1.2.3", STUB_ARCHIVE_FAIL: "1" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /download failed/);
  assert.deepEqual(outcome.leftovers, []);
});

test("a manifest version that differs from the tag is refused", { skip }, async () => {
  const { archive } = await buildRelease({ version: "1.2.3", manifestVersion: "1.2.2" });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /package\.json has version 1\.2\.2, expected 1\.2\.3/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("a release without the OpenCode plugin is refused", { skip }, async () => {
  const { archive } = await buildRelease({ extra: (root) => rm(path.join(root, "plugins", "opencode", "useful-skills.js")) });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /has no plugins\/opencode\/useful-skills\.js/);
  assert.equal(outcome.recorded, null);
});

test("the exit code of the release installer is propagated and the download is removed", { skip }, async () => {
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3", INSTALLER_EXIT: "7" } });
  assert.equal(outcome.status, 7);
  assert.match(outcome.stderr, /installer failed \(exit 7\)/);
  assert.doesNotMatch(outcome.stdout, /Restart OpenCode/);
  assert.deepEqual(outcome.leftovers, []);
});

test("an absolute entry name is refused", { skip }, async () => {
  const archive = await rawArchiveFile([{ name: "/tmp/evil", content: "x" }]);
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /unsafe entry name/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("an entry name with a .. segment is refused", { skip }, async () => {
  const archive = await rawArchiveFile([{ name: "top/" }, { name: "top/../evil", content: "x" }]);
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /unsafe entry name/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("an entry that declares more than the size limit is refused before extraction", { skip }, async () => {
  const archive = (await buildRelease()).archive;
  const bin = await tarListingStub({
    names: ["top/", "top/big"],
    verbose: ["drwxr-xr-x u/g 0 2024-01-01 00:00 top/", "-rw-r--r-- u/g 999999999999 2024-01-01 00:00 top/big"],
  });
  const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /expands beyond the size limit/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("entries that add up to more than the size limit are refused", { skip }, async () => {
  const archive = (await buildRelease()).archive;
  const bin = await tarListingStub({
    names: ["top/", "top/a", "top/b"],
    verbose: [
      "drwxr-xr-x  0 u g          0 Jan  1 00:00 top/",
      "-rw-r--r--  0 u g  300000000 Jan  1 00:00 top/a",
      "-rw-r--r--  0 u g  300000000 Jan  1  2023 top/b",
    ],
  });
  const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /expands beyond the size limit/);
  assert.deepEqual(outcome.leftovers, []);
});

test("a listing whose sizes cannot be read is refused", { skip }, async () => {
  const archive = (await buildRelease()).archive;
  const bin = await tarListingStub({
    names: ["top/", "top/a"],
    verbose: ["drwxr-xr-x u/g 0 2024-01-01 00:00 top/", "-rw-r--r-- somebody-else top/a"],
  });
  const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /couldn't read the entry sizes/);
  assert.deepEqual(outcome.leftovers, []);
});

test("a relative TMPDIR works and is cleaned up", { skip }, async () => {
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, relativeTemp: true, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
  assert.deepEqual(outcome.leftovers, []);
});

test("a missing curl is refused before anything else", { skip }, async () => {
  // Every tool the script needs except curl, linked into one directory that becomes the whole PATH.
  const tools = await directory("tools");
  for (const name of ["sh", "tar", "gzip", "grep", "cut", "sort", "wc", "tr", "head", "find", "awk", "mktemp", "rm", "chmod", "mkdir", "cat", "uname"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, path.join(tools, name));
  }
  await symlink(path.join(shims, "node"), path.join(tools, "node"));
  const outcome = await runInstaller({ path: tools, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /'curl' is required/);
  assert.deepEqual(outcome.downloads, []);
  assert.deepEqual(outcome.leftovers, []);
});

test("a bsdtar listing with a localized month is read", { skip }, async () => {
  for (const month of ["pa\u017a", "M\u00e4r", "oct."]) {
    const { archive } = await buildRelease();
    const bin = await bsdListingStub(month);
    const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
    assert.equal(outcome.status, 0, `${month}: ${outcome.stderr}`);
    assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
  }
});

test("a listing that imitates other columns to shift the size field is refused", { skip }, async () => {
  const archive = (await buildRelease()).archive;
  const bin = await tarListingStub({
    names: ["pkg/", "pkg/hole"],
    verbose: ["drwxr-xr-x u/g 0 2024-01-01 00:00 pkg/", "-rw-r--r-- u/g 1 Jan 3221225472 100000000000000000 pkg/hole"],
  });
  const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /couldn't read the entry sizes/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("a latest release tag without the v prefix is refused", { skip }, async () => {
  const outcome = await runInstaller({ api: { tag_name: "1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /HARNESS_SKILLS_VERSION/);
  assert.equal(outcome.downloads.length, 1, "only the API was asked");
});

test("HARNESS_SKILLS_VERSION=latest means the latest release", { skip }, async () => {
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, api: { tag_name: "v1.2.3" }, env: { HARNESS_SKILLS_VERSION: "latest" } });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.downloads.length, 2);
});

test("a manifest version that is not a plain version is not echoed", { skip }, async () => {
  const { archive } = await buildRelease({ manifestVersion: "1.2.3\u001b[31mred" });
  const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /has version \(missing or not a version\), expected 1\.2\.3/);
  assert.doesNotMatch(outcome.stderr, /\u001b\[31m/);
});

test("entries without an owner write bit are refused, including a directory with no permissions", { skip }, async () => {
  for (const entries of [
    [{ name: "top/" }, { name: "top/readonly", content: "x", mode: "0000444" }],
    [{ name: "top/" }, { name: "top/locked/", mode: "0000000" }, { name: "top/locked/inner", content: "x" }],
  ]) {
    const archive = await rawArchiveFile(entries);
    const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /without owner write permission/);
    assert.equal(outcome.recorded, null);
    assert.deepEqual(outcome.leftovers, []);
  }
});

test("a name segment that ends in a dot or a space is refused", { skip }, async () => {
  for (const name of ["top/file.", "top/file ", "top/dir./inner", "top/dir /inner"]) {
    const archive = await rawArchiveFile([{ name: "top/" }, { name, content: "x" }]);
    const outcome = await runInstaller({ archive, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
    assert.notEqual(outcome.status, 0, name);
    assert.match(outcome.stderr, /unsafe entry name/, name);
    assert.equal(outcome.recorded, null);
    assert.deepEqual(outcome.leftovers, []);
  }
});

test("a walk of the extracted tree that cannot finish is refused, never passed", { skip }, async () => {
  const { archive } = await buildRelease();
  const real = spawnSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).stdout.trim();
  for (const body of ["exit 1", `"${real}" "$@"; exit 1`]) {
    const bin = await directory("find-stub");
    await writeFile(path.join(bin, "find"), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(bin, "find"), 0o755);
    const outcome = await runInstaller({ archive, bin, env: { HARNESS_SKILLS_VERSION: "v1.2.3" } });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /couldn't read the whole extracted release/);
    assert.equal(outcome.recorded, null);
    assert.deepEqual(outcome.leftovers, []);
  }
});
