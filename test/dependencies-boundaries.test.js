import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireSetupLock } from "../setup-lock.js";
import { createDependencyManager } from "../dependencies.js";

const committedDependencies = path.resolve(import.meta.dirname, "../dependencies");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const unexpectedRun = async () => { throw new Error("Unexpected executable invocation"); };
const healthyRun = async (_file, args) => ({ stdout: args.includes("--version") ? "Python 3.12.14\n" : "0.9.65\n" });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-dependency-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "profile");
  const dependenciesRoot = path.join(root, "dependencies");
  const archive = Buffer.from("local archive fixture");
  const original = JSON.parse(await readFile(path.join(committedDependencies, "manifest.json"), "utf8"));
  const manifest = JSON.stringify({
    ...original,
    uv: { ...original.uv, platforms: {
      ...original.uv.platforms,
      "linux-x64": { ...original.uv.platforms["linux-x64"], sha256: digest(archive) },
    } },
  });
  const lock = await readFile(path.join(committedDependencies, "graphify.lock"));
  await mkdir(dependenciesRoot);
  await writeFile(path.join(dependenciesRoot, "manifest.json"), manifest);
  await writeFile(path.join(dependenciesRoot, "graphify.lock"), lock);
  const lockHash = digest(Buffer.concat([Buffer.from(manifest), Buffer.from([0]), lock]));
  const storage = path.join(agentDir, "useful-skills", "dependencies");
  const versionRoot = path.join(storage, lockHash);
  return { root, agentDir, dependenciesRoot, archive, manifest, lockHash, storage, versionRoot,
    python: path.join(versionRoot, "venv", "bin", "python") };
}

async function installedFixture(t) {
  const source = await fixture(t);
  await mkdir(path.dirname(source.python), { recursive: true });
  await writeFile(source.python, "fixture interpreter");
  await writeFile(path.join(source.versionRoot, "installation.json"), JSON.stringify({
    lockHash: source.lockHash, version: "0.9.65",
  }));
  return source;
}

function manager(source, options = {}) {
  return createDependencyManager({
    dependenciesRoot: source.dependenciesRoot,
    run: unexpectedRun,
    fetch: async () => new Response(source.archive),
    ...options,
  });
}

async function assertFailedSetupRetainsLock(source) {
  assert.deepEqual(await readdir(source.storage), [".setup.lock"]);
}

test("dependency manager rejects invalid adapters, deadlines, and profile arguments", async (t) => {
  assert.throws(() => createDependencyManager({ fetch: null }), TypeError);
  assert.throws(() => createDependencyManager({ run: false }), TypeError);
  assert.throws(() => createDependencyManager({ setupTimeoutMs: 0 }), TypeError);
  const source = await fixture(t);
  const dependency = manager(source);
  await assert.rejects(dependency.status(), /agentDir/i);
  await assert.rejects(dependency.ensure({ agentDir: "" }), /agentDir/i);
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
});

test("a malformed archive digest is rejected independently of archive path validation", async (t) => {
  const source = await fixture(t);
  const manifest = JSON.parse(source.manifest);
  const invalid = {
    ...manifest,
    python: { ...manifest.python, platforms: {
      ...manifest.python.platforms,
      "linux-x64": { ...manifest.python.platforms["linux-x64"], sha256: "not-a-digest" },
    } },
  };
  await writeFile(path.join(source.dependenciesRoot, "manifest.json"), JSON.stringify(invalid));
  await assert.rejects(manager(source).status({ agentDir: source.agentDir }), /metadata is invalid/i);
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
});

test("cancellation while waiting for another setup preserves that setup's lock", async (t) => {
  const source = await fixture(t);
  await mkdir(source.storage, { recursive: true });
  const lock = path.join(source.storage, ".setup.lock");
  const lease = await acquireSetupLock(lock, {});
  t.after(() => lease.release());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("cancel setup waiting for lock"), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(manager(source).ensure({ agentDir: source.agentDir, signal: controller.signal }), /cancelled/i);
  assert.deepEqual(await readdir(source.storage), [".setup.lock"]);
});
test("simultaneous fresh-profile setups converge before dependency setup", async (t) => {
  const source = await fixture(t);
  const setups = Array.from({ length: 12 }, () => manager(source, {
    fetch: async () => new Response("unavailable", { status: 503 }),
  }).ensure({ agentDir: source.agentDir }));

  const results = await Promise.allSettled(setups);

  assert.equal(results.every((result) => result.status === "rejected" && /HTTP 503/.test(result.reason.message)), true);
  assert.deepEqual(await readdir(source.storage), [".setup.lock"]);
});

test("pre-cancelled setup leaves the profile uncreated and preserves the abort reason", async (t) => {
  const source = await fixture(t);
  const reason = new Error("Setup no longer requested");
  const dependency = manager(source, { fetch: async () => { throw new Error("Unexpected download"); } });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir, signal: AbortSignal.abort(reason) }),
    (error) => error === reason);
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
});

test("owned storage refuses a symlink without modifying its destination", async (t) => {
  const source = await fixture(t);
  const outside = path.join(source.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep"), "untouched");
  await mkdir(source.agentDir);
  await symlink(outside, path.join(source.agentDir, "useful-skills"));
  await assert.rejects(manager(source).ensure({ agentDir: source.agentDir }), /not a symlink/i);
  assert.deepEqual(await readdir(outside), ["keep"]);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "untouched");
});

test("a symlinked profile cannot redirect managed installation", async (t) => {
  const source = await fixture(t);
  const outside = path.join(source.root, "outside");
  await mkdir(outside);
  await symlink(outside, source.agentDir);
  await assert.rejects(manager(source).ensure({ agentDir: source.agentDir }), /real directory/i);
  assert.deepEqual(await readdir(outside), []);
});

test("truncated activation metadata remains partial and is not repaired by status", async (t) => {
  const source = await installedFixture(t);
  const marker = path.join(source.versionRoot, "installation.json");
  await writeFile(marker, "{\"lockHash\":");
  const result = await manager(source, { run: healthyRun }).status({ agentDir: source.agentDir });
  assert.equal(result.ready, false);
  assert.equal(result.state, "partial");
  assert.equal(await readFile(marker, "utf8"), "{\"lockHash\":");
});

test("a marker for another lock cannot activate the current installation", async (t) => {
  const source = await installedFixture(t);
  await writeFile(path.join(source.versionRoot, "installation.json"), JSON.stringify({
    lockHash: "0".repeat(64), version: "0.9.65",
  }));
  const result = await manager(source, { run: healthyRun }).status({ agentDir: source.agentDir });
  assert.equal(result.ready, false);
  assert.equal(result.state, "partial");
});

test("an interpreter escaping the installation is never executed", async (t) => {
  const source = await installedFixture(t);
  const outside = path.join(source.root, "outside-python");
  await writeFile(outside, "external interpreter");
  await rm(source.python);
  await symlink(outside, source.python);
  const calls = [];
  const result = await manager(source, { run: async (...args) => { calls.push(args); return { stdout: "Python 3.12.14" }; } })
    .status({ agentDir: source.agentDir });
  assert.equal(result.ready, false);
  assert.equal(result.state, "partial");
  assert.deepEqual(calls, []);
});

test("a valid marker cannot hide a missing interpreter or a failed package import", async (t) => {
  const source = await installedFixture(t);
  await rm(source.python);
  const dependency = manager(source, {
    run: async (_file, args) => {
      if (args.includes("--version")) return { stdout: "Python 3.12.14\n" };
      throw new Error("ModuleNotFoundError: graphify");
    },
  });
  assert.equal((await dependency.status({ agentDir: source.agentDir })).ready, false);
  await writeFile(source.python, "restored interpreter");
  assert.equal((await dependency.status({ agentDir: source.agentDir })).ready, false);
});

test("the wrong interpreter version is partial even when the activation marker matches", async (t) => {
  const source = await installedFixture(t);
  const result = await manager(source, { run: async () => ({ stdout: "Python 3.13.0\n" }) })
    .status({ agentDir: source.agentDir });
  assert.equal(result.ready, false);
  assert.equal(result.state, "partial");
});

test("HTTP failure removes setup artifacts while retaining the reusable setup lock", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, { fetch: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /HTTP 503/);
  await assertFailedSetupRetainsLock(source);
});

test("an otherwise successful HTTP response must contain a download body", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, { fetch: async () => new Response(null, { status: 204 }) });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /HTTP 204/);
  await assertFailedSetupRetainsLock(source);
});

test("approved redirect loops are bounded and never processed as an archive", async (t) => {
  const source = await fixture(t);
  const urls = [];
  const dependency = manager(source, {
    fetch: async (url) => {
      urls.push(url);
      return new Response(null, { status: 307, headers: { location: "/release/retry" } });
    },
  });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /redirect limit/i);
  assert.equal(urls.length, 4);
  assert.equal(new URL(urls[1]).pathname, "/release/retry");
  await assertFailedSetupRetainsLock(source);
});

test("a redirect without a destination cannot activate an installation", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, { fetch: async () => new Response(null, { status: 302 }) });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /redirect limit/i);
  await assertFailedSetupRetainsLock(source);
});

test("an interrupted download discards partial bytes and permits a fresh retry", async (t) => {
  const source = await fixture(t);
  const streamError = new Error("download connection interrupted");
  const dependency = manager(source, {
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("partial archive")); },
      pull(controller) { controller.error(streamError); },
    })),
  });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), (error) => error === streamError);
  await assertFailedSetupRetainsLock(source);
  const retry = manager(source, { fetch: async () => new Response("retry reached transport", { status: 503 }) });
  await assert.rejects(retry.ensure({ agentDir: source.agentDir }), /HTTP 503/);
  await assertFailedSetupRetainsLock(source);
});

test("archive parser rejects unrecognized listings before extraction", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, { run: async () => ({ stdout: "unrecognized tar output\n" }) });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /unsupported entry format/i);
  await assertFailedSetupRetainsLock(source);
});

test("archive traversal entries cannot write outside staging", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, {
    run: async () => ({ stdout: "-rw-r--r-- root/root 1 2026-01-01 00:00 ../outside\n" }),
  });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /unsafe path/i);
  await assert.rejects(stat(path.join(source.storage, "outside")), { code: "ENOENT" });
  await assertFailedSetupRetainsLock(source);
});

test("an archive without the pinned executable is not accepted", async (t) => {
  const source = await fixture(t);
  const dependency = manager(source, {
    run: async () => ({ stdout: "-rw-r--r-- root/root 1 2026-01-01 00:00 readme\n" }),
  });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /did not contain the pinned uv executable/i);
  await assertFailedSetupRetainsLock(source);
});

test("extraction output is rechecked rather than trusting the archive listing", async (t) => {
  const source = await fixture(t);
  const executable = JSON.parse(source.manifest).uv.platforms["linux-x64"].executable;
  const outside = path.join(source.root, "untrusted-uv");
  await writeFile(outside, "not a managed executable");
  const dependency = manager(source, {
    run: async (_file, args, options) => {
      if (args.includes("-tvzf")) return { stdout: `-rwxr-xr-x root/root 1 2026-01-01 00:00 ${executable}\n` };
      if (args.includes("-xzf")) {
        const target = path.join(options.cwd, executable);
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(outside, target);
        return { stdout: "" };
      }
      throw new Error("Untrusted executable must not run");
    },
  });
  await assert.rejects(dependency.ensure({ agentDir: source.agentDir }), /did not safely extract/i);
  assert.equal(await readFile(outside, "utf8"), "not a managed executable");
  await assertFailedSetupRetainsLock(source);
});
