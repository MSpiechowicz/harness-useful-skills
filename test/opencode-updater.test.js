import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

import { RELEASE_API, UpdateError } from "../release-check.js";
import { checkOpenCodeUpdate, installOpenCodeUpdate } from "../opencode/updater.js";

const exec = promisify(execFile);

// Fixtures live under `base`; the updater's own temporary directories go to `scratch`, which must stay empty.
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-updater-")));
const scratch = path.join(base, "tmp");
await mkdir(scratch);
process.env.TMPDIR = scratch;
after(() => rm(base, { recursive: true, force: true }));

const NOT_INSTALLED = /not an installed OpenCode copy; source checkouts are never overwritten/;
const token = async () => null;

async function writeRecord({ scopeRoot, scope, home }, version) {
  const record = { schema: 1, version, scope, scopeRoot, dataDir: path.join(home, "data"), configFile: null, mcpEntry: null, files: {} };
  const runtimeRoot = path.join(scopeRoot, "plugins", "useful-skills");
  await writeFile(path.join(runtimeRoot, "install-record.json"), JSON.stringify(record));
  await writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({ name: "useful-skills-opencode", version }));
}

/** An installed OpenCode runtime tree with its install record, in a private HOME. */
async function installedCopy({ scope = "user", version = "1.0.0" } = {}) {
  const home = await mkdtemp(path.join(base, "home-"));
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "share"), PATH: process.env.PATH };
  const scopeRoot = scope === "user" ? path.join(home, "config", "opencode") : path.join(home, "project", ".opencode");
  const runtimeRoot = path.join(scopeRoot, "plugins", "useful-skills");
  await mkdir(runtimeRoot, { recursive: true });

  const copy = { home, environment, scope, scopeRoot, runtimeRoot };
  await writeRecord(copy, version);
  return copy;
}

async function recordedVersion(copy) {
  return JSON.parse(await readFile(path.join(copy.runtimeRoot, "install-record.json"), "utf8")).version;
}

const FIXTURE_INSTALLER = `const fs = require("node:fs");
fs.writeFileSync(process.env.US_TEST_REPORT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const recordFile = process.env.US_TEST_RECORD;
const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
const version = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "package.json"), "utf8")).version;
fs.writeFileSync(recordFile, JSON.stringify({ ...record, version }));
console.log("fixture installer installed " + version);
`;

/**
 * A gzip source tarball shaped like a GitHub tag archive: one top-level directory holding the release launcher and
 * the OpenCode bundle. `change` edits the tree before packing; `tarArgs` and `members` shape the archive itself.
 */
async function releaseArchive(version, { change = async () => {}, tarArgs = [], members } = {}) {
  const work = await mkdtemp(path.join(base, "release-"));
  const top = `harness-useful-skills-${version}`;
  const root = path.join(work, top);
  await mkdir(path.join(root, "plugins", "opencode", "useful-skills"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "harness-useful-skills", version }));
  await writeFile(path.join(root, "plugins", "opencode", "useful-skills", "package.json"), JSON.stringify({ name: "useful-skills-opencode", version }));
  await writeFile(path.join(root, "plugins", "opencode", "useful-skills.js"), "export {};\n");
  await writeFile(path.join(root, "useful-skills"), FIXTURE_INSTALLER);
  await change(root, work);

  const archive = path.join(work, "release.tar.gz");
  await exec("tar", ["-czf", archive, ...tarArgs, "-C", work, ...(members ?? [top])]);
  return readFile(archive);
}

/** A GitHub stand-in: the release API announces `version`; every other request is recorded and gets `download`. */
function github(version, download) {
  const downloads = [];
  const fetcher = async (url, init) => {
    if (url === RELEASE_API) {
      return new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: `v${version}` }), { status: 200 });
    }

    downloads.push({ url, init });
    return typeof download === "function" ? download(url) : new Response(download, { status: 200 });
  };
  return { fetcher, downloads };
}

/** A runner standing in for the downloaded installer: records the call and writes the new install record. */
function fakeInstaller(copy, version) {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options, launcher: await readFile(args[0], "utf8") });
    await writeRecord(copy, version);
    return "Installed Useful Skills.\n";
  };
  return { runner, calls };
}

async function assertNoTemporaryFiles() {
  assert.deepEqual(await readdir(scratch), []);
}

test("check reports a newer stable release for an installed copy", async () => {
  const copy = await installedCopy();
  const { fetcher } = github("1.0.1");
  const report = await checkOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, token });

  assert.equal(report.currentVersion, "1.0.0");
  assert.equal(report.latestVersion, "1.0.1");
  assert.equal(report.updateAvailable, true);
  assert.match(report.message, /1\.0\.1 is available \(installed: 1\.0\.0\)/);
  assert.match(report.message, /\.\/useful-skills update install --host opencode`/);

  const project = await installedCopy({ scope: "project" });
  const projectReport = await checkOpenCodeUpdate({ environment: project.environment, runtimeRoot: project.runtimeRoot, fetcher, token });
  assert.match(projectReport.message, /--host opencode --scope project/);
});

test("check reports up to date, a missing release, and a source checkout without touching the network for a checkout", async () => {
  const copy = await installedCopy({ version: "1.0.1" });
  const current = await checkOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher: github("1.0.1").fetcher, token });
  assert.equal(current.updateAvailable, false);
  assert.match(current.message, /1\.0\.1 is up to date/);

  const missing = await checkOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher: async () => new Response("", { status: 404 }), token });
  assert.equal(missing.latestVersion, null);
  assert.match(missing.message, /No published stable GitHub release/);

  let requests = 0;
  const checkout = await checkOpenCodeUpdate({ runtimeRoot: path.resolve(import.meta.dirname, ".."), fetcher: async () => { requests += 1; }, token });
  assert.equal(checkout.updateAvailable, false);
  assert.match(checkout.message, NOT_INSTALLED);
  assert.equal(requests, 0);
});

test("install downloads the tag tarball, verifies it, and runs its installer in the recorded scope", async () => {
  const copy = await installedCopy();
  const { fetcher, downloads } = github("1.0.1", await releaseArchive("1.0.1"));
  const { runner, calls } = fakeInstaller(copy, "1.0.1");
  const result = await installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token });

  assert.equal(result.updated, true);
  assert.equal(result.currentVersion, "1.0.1");
  assert.match(result.message, /Installed Useful Skills\.\nUpdated Useful Skills for OpenCode from 1\.0\.0 to 1\.0\.1\. Restart OpenCode/);

  assert.deepEqual(downloads.map(({ url }) => url), ["https://codeload.github.com/MSpiechowicz/harness-useful-skills/tar.gz/refs/tags/v1.0.1"]);
  assert.equal(downloads[0].init.redirect, "manual");
  assert.equal(downloads[0].init.headers.Authorization, undefined);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "node");
  assert.deepEqual(calls[0].args.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
  assert.equal(path.basename(calls[0].args[0]), "useful-skills");
  assert.equal(calls[0].launcher, FIXTURE_INSTALLER);
  assert.equal(calls[0].options.cwd, copy.home);
  assert.equal(calls[0].options.env.XDG_CONFIG_HOME, copy.environment.XDG_CONFIG_HOME);
  await assertNoTemporaryFiles();
});

test("install runs the real downloaded installer with node and propagates its output", async () => {
  const copy = await installedCopy({ scope: "project" });
  const reportFile = path.join(copy.home, "installer-report.json");
  const environment = { ...copy.environment, US_TEST_REPORT: reportFile, US_TEST_RECORD: path.join(copy.runtimeRoot, "install-record.json") };
  const { fetcher } = github("1.0.1", await releaseArchive("1.0.1"));
  const result = await installOpenCodeUpdate({ environment, runtimeRoot: copy.runtimeRoot, fetcher, token });

  assert.equal(result.updated, true);
  assert.match(result.message, /^fixture installer installed 1\.0\.1\n/);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.deepEqual(report.args, ["install", "--host", "opencode", "--scope", "project"]);
  assert.equal(report.cwd, path.dirname(copy.scopeRoot));
  assert.equal(await recordedVersion(copy), "1.0.1");
  await assertNoTemporaryFiles();
});

test("install changes nothing when no newer release exists or the copy is a source checkout", async () => {
  const copy = await installedCopy({ version: "1.0.1" });
  const { fetcher, downloads } = github("1.0.1", await releaseArchive("1.0.1"));
  const { runner, calls } = fakeInstaller(copy, "9.9.9");
  const result = await installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token });
  assert.equal(result.updated, false);
  assert.match(result.message, /No newer stable release/);
  assert.equal(downloads.length + calls.length, 0);

  const checkout = path.resolve(import.meta.dirname, "..");
  await assert.rejects(installOpenCodeUpdate({ runtimeRoot: checkout, fetcher, runner, token }), NOT_INSTALLED);
  assert.equal(downloads.length + calls.length, 0);
});

test("install refuses when this environment resolves the recorded scope somewhere else", async () => {
  const copy = await installedCopy();
  const { fetcher, downloads } = github("1.0.1", await releaseArchive("1.0.1"));
  const { runner, calls } = fakeInstaller(copy, "1.0.1");
  const environment = { ...copy.environment, XDG_CONFIG_HOME: path.join(copy.home, "elsewhere") };
  await assert.rejects(installOpenCodeUpdate({ environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token }), /refusing to install the update elsewhere/);
  assert.equal(downloads.length + calls.length, 0);
  assert.equal(await recordedVersion(copy), "1.0.0");
});

const unsafeArchives = {
  "a symbolic link": [{ change: root => symlink("/etc/passwd", path.join(root, "linked")) }, /"harness-useful-skills-1\.0\.1\/linked" is not a plain file/],
  "a hard link": [{ change: root => link(path.join(root, "package.json"), path.join(root, "hard.json")) }, /is not a plain file or directory/],
  "a FIFO": [{ change: root => exec("mkfifo", [path.join(root, "pipe")]) }, /"harness-useful-skills-1\.0\.1\/pipe" is not a plain file/],
  "a .. component": [{ tarArgs: ["--transform", "s,^harness-useful-skills-1.0.1/package.json$,harness-useful-skills-1.0.1/../escape.json,"] }, /unsafe entry name "harness-useful-skills-1\.0\.1\/\.\.\/escape\.json"/],
  "an absolute path": [{ tarArgs: ["-P", "--transform", "s,^harness-useful-skills-1.0.1/package.json$,/tmp/escape.json,"] }, /unsafe entry name "\/tmp\/escape\.json"/],
  "a second top-level entry": [{ change: (_root, work) => writeFile(path.join(work, "extra.txt"), "x"), members: ["harness-useful-skills-1.0.1", "extra.txt"] }, /exactly one top-level directory/],
  "a mismatched root version": [{ change: root => writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" })) }, /package\.json has version 1\.0\.0, expected 1\.0\.1/],
  "a mismatched bundle version": [{ change: root => writeFile(path.join(root, "plugins", "opencode", "useful-skills", "package.json"), JSON.stringify({ version: "1.0.2" })) }, /useful-skills\/package\.json has version 1\.0\.2/],
  "no OpenCode bundle entry": [{ change: root => rm(path.join(root, "plugins", "opencode", "useful-skills.js")) }, /has no plugins\/opencode\/useful-skills\.js/],
  "no release launcher": [{ change: root => rm(path.join(root, "useful-skills")) }, /has no useful-skills;/],
};

for (const [name, [shape, expected]] of Object.entries(unsafeArchives)) {
  test(`install rejects a release archive with ${name} before running anything`, async () => {
    const copy = await installedCopy();
    const { fetcher } = github("1.0.1", await releaseArchive("1.0.1", shape));
    const { runner, calls } = fakeInstaller(copy, "1.0.1");
    const failure = installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token });

    await assert.rejects(failure, error => error instanceof UpdateError && expected.test(error.message));
    assert.equal(calls.length, 0);
    assert.equal(await recordedVersion(copy), "1.0.0");
    await assertNoTemporaryFiles();
  });
}

test("install stops an oversized download as soon as it passes the limit", async () => {
  const copy = await installedCopy();
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const endless = () => new Response(new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(chunk);
    },
  }), { status: 200 });
  const { runner, calls } = fakeInstaller(copy, "1.0.1");

  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher: github("1.0.1", endless).fetcher, runner, token }),
    /exceeds the 128 MiB download limit/,
  );
  assert.ok(sent <= 132, `read ${sent} MiB`);

  const declared = () => new Response("x", { status: 200, headers: { "content-length": String(1024 ** 3) } });
  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher: github("1.0.1", declared).fetcher, runner, token }),
    /download limit/,
  );
  assert.equal(calls.length, 0);
  await assertNoTemporaryFiles();
});

test("install rejects an archive that expands beyond the size limit before extracting it", async () => {
  const copy = await installedCopy();
  const bomb = path.join(await mkdtemp(path.join(base, "bomb-")), "bomb.tar.gz");
  const zeros = Buffer.alloc(1024 * 1024);
  await pipeline(Readable.from((function* () {
    for (let index = 0; index < 520; index += 1) yield zeros;
  })()), createGzip({ level: 1 }), createWriteStream(bomb));
  let tarCalls = 0;
  const tar = async () => { tarCalls += 1; return ""; };
  const { runner, calls } = fakeInstaller(copy, "1.0.1");

  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher: github("1.0.1", await readFile(bomb)).fetcher, runner, tar, token }),
    /expands beyond the size limit/,
  );
  assert.equal(tarCalls + calls.length, 0);
  await assertNoTemporaryFiles();
});

test("install follows redirects only to https GitHub download hosts", async () => {
  const copy = await installedCopy();
  const archive = await releaseArchive("1.0.1");
  const { runner, calls } = fakeInstaller(copy, "1.0.1");
  const redirectTo = location => url => (url.startsWith("https://codeload.github.com/")
    ? new Response(null, { status: 302, headers: { location } })
    : new Response(archive, { status: 200 }));

  for (const location of ["https://evil.example/archive.tar.gz", "http://github.com/archive.tar.gz", "https://user@github.com/archive.tar.gz"]) {
    const { fetcher, downloads } = github("1.0.1", redirectTo(location));
    await assert.rejects(installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token }), /Refusing to download the release from/);
    assert.equal(downloads.length, 1);
  }
  assert.equal(calls.length, 0);

  const { fetcher, downloads } = github("1.0.1", redirectTo("https://github.com/MSpiechowicz/harness-useful-skills/archive.tar.gz"));
  const result = await installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, token });
  assert.equal(result.updated, true);
  assert.equal(downloads.at(-1).url, "https://github.com/MSpiechowicz/harness-useful-skills/archive.tar.gz");
  await assertNoTemporaryFiles();
});

test("install reports a failed installer and a record the installer did not update", async () => {
  const copy = await installedCopy();
  const { fetcher } = github("1.0.1", await releaseArchive("1.0.1"));
  const failing = async () => {
    throw Object.assign(new Error("Command failed"), { stderr: "Refusing to install; nothing was changed: agents/us-planner.md exists.\n" });
  };
  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner: failing, token }),
    /1\.0\.1 installer failed:\nRefusing to install; nothing was changed/,
  );

  const silent = async () => "done\n";
  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner: silent, token }),
    /install record does not show the new version/,
  );
  await assertNoTemporaryFiles();
});

test("install re-checks the extracted tree, so a link the listing missed still stops the update", async () => {
  const copy = await installedCopy();
  const { fetcher } = github("1.0.1", await releaseArchive("1.0.1", { change: root => symlink("/etc", path.join(root, "linked")) }));
  const { runner, calls } = fakeInstaller(copy, "1.0.1");
  const top = "harness-useful-skills-1.0.1";
  // A tar whose listing omits the link but which extracts the real archive.
  const tar = async (args, options) => {
    if (args.includes("-t")) {
      return args.includes("-v") ? `drwxr-xr-x u/g 0 2026-01-01 00:00 ${top}/\n` : `${top}/\n`;
    }
    return (await exec("tar", args, { env: options.env })).stdout;
  };

  await assert.rejects(
    installOpenCodeUpdate({ environment: copy.environment, runtimeRoot: copy.runtimeRoot, fetcher, runner, tar, token }),
    /extracted release contains "harness-useful-skills-1\.0\.1\/linked"/,
  );
  assert.equal(calls.length, 0);
  await assertNoTemporaryFiles();
});

test("install removes its temporary directory when a signal ends the command mid-download", async () => {
  const copy = await installedCopy();
  const tmp = await mkdtemp(path.join(base, "signal-tmp-"));
  const entry = path.join(base, "signalled-update.mjs");
  const module = (file) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "..", file)).href);
  await writeFile(entry, [
    `import { exitOnTermination } from ${module("process.js")};`,
    `import { RELEASE_API } from ${module("release-check.js")};`,
    `import { installOpenCodeUpdate } from ${module("opencode/updater.js")};`,
    "const { environment, runtimeRoot } = JSON.parse(process.argv[2]);",
    "exitOnTermination();",
    "setInterval(() => {}, 1_000);",
    "const fetcher = async (url) => {",
    "  if (url === RELEASE_API) return new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v1.0.1' }));",
    "  process.stdout.write('downloading\\n');",
    "  return new Promise(() => {});",
    "};",
    "await installOpenCodeUpdate({ environment, runtimeRoot, fetcher, token: async () => null });",
  ].join("\n"));

  const options = JSON.stringify({ environment: copy.environment, runtimeRoot: copy.runtimeRoot });
  const child = spawn(process.execPath, [entry, options], { env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  assert.equal((await readdir(tmp)).length, 1);

  child.kill("SIGTERM");
  assert.deepEqual(await exited, [143, null]);
  assert.deepEqual(await readdir(tmp), []);
});
