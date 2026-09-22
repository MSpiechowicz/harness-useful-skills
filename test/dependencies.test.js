import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireSetupLock } from "../setup-lock.js";
import { createDependencyManager, dependencyStatus } from "../dependencies.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const dependenciesRoot = path.join(repositoryRoot, "dependencies");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function dependencyLockHash(manifest, lock) {
  return sha256(Buffer.concat([Buffer.from(manifest), Buffer.from([0]), Buffer.from(lock)]));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-skills-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependencyRoot = path.join(root, "package-dependencies");
  const agentDir = path.join(root, "profile");
  const uvArchive = Buffer.from("fake uv archive");
  const pythonArchive = Buffer.from("fake python archive");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    uv: {
      version: "0.12.17",
      platforms: {
        "linux-x64": {
          url: "https://github.com/example/uv.tar.gz",
          sha256: sha256(uvArchive),
          archive: "tar.gz",
          executable: "uv/uv",
        },
      },
    },
    python: {
      version: "3.12.14",
      build: "20260901",
      platforms: {
        "linux-x64": {
          url: "https://github.com/example/python.tar.gz",
          sha256: sha256(pythonArchive),
          mirror: "https://github.com/example",
          archive: "python.tar.gz",
        },
      },
    },
    graphify: {
      package: "graphifyy",
      version: "0.9.65",
      sha256: "e4c1ef6967d5a090b315f9b18b5255d9a0dead0c24a7620e7dffeaa443395535",
    },
  });
  const lock = "graphifyy==0.9.65 --hash=sha256:e4c1ef6967d5a090b315f9b18b5255d9a0dead0c24a7620e7dffeaa443395535\n";
  await mkdir(dependencyRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(dependencyRoot, "manifest.json"), manifest),
    writeFile(path.join(dependencyRoot, "graphify.lock"), lock),
  ]);
  return { agentDir, dependencyRoot, lock, manifest, pythonArchive, uvArchive };
}

function response(body, { status = 200, location } = {}) {
  return {
    body: status === 200 ? new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }) : null,
    headers: new Headers(location ? { location } : {}),
    ok: status >= 200 && status < 300,
    status,
  };
}

test("dependency status is read-only when no profile state exists", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "useful-skills-dependencies-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const agentDir = path.join(parent, "missing-profile");

  const result = await dependencyStatus({ agentDir });

  assert.equal(result.ready, false);
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
});

test("dependency status identifies a partial version directory without repairing it", async (t) => {
  const manifest = await readFile(path.join(dependenciesRoot, "manifest.json"));
  const lock = await readFile(path.join(dependenciesRoot, "graphify.lock"));
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "useful-skills-dependencies-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const versionRoot = path.join(agentDir, "useful-skills", "dependencies", dependencyLockHash(manifest, lock));
  await mkdir(versionRoot, { recursive: true });

  const result = await dependencyStatus({ agentDir });

  assert.equal(result.ready, false);
  assert.equal(result.state, "partial");
  assert.equal(result.versionRoot, versionRoot);
  await stat(versionRoot);
});

test("metadata rejects an escaping executable path", async (t) => {
  const source = await fixture(t);
  const manifest = JSON.parse(source.manifest);
  const invalid = {
    ...manifest,
    uv: { ...manifest.uv, platforms: {
      ...manifest.uv.platforms,
      "linux-x64": { ...manifest.uv.platforms["linux-x64"], executable: "../uv" },
    } },
  };
  await writeFile(path.join(source.dependencyRoot, "manifest.json"), JSON.stringify(invalid));
  const manager = createDependencyManager({ dependenciesRoot: source.dependencyRoot });

  await assert.rejects(manager.status({ agentDir: source.agentDir }), /metadata is invalid/i);
});

test("offline reuse requires exact interpreter and package health before returning", async (t) => {
  const source = await fixture(t);
  const lockHash = dependencyLockHash(source.manifest, source.lock);
  const versionRoot = path.join(source.agentDir, "useful-skills", "dependencies", lockHash);
  const python = path.join(versionRoot, "venv", "bin", "python");
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(python, "");
  await chmod(python, 0o700);
  await writeFile(path.join(versionRoot, "installation.json"), JSON.stringify({ lockHash, version: "0.9.65" }));
  const calls = [];
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.join(" ") === "--version") return { stdout: "Python 3.12.14\n", stderr: "" };
      return { stdout: "0.9.65\n", stderr: "" };
    },
    fetch: async () => { throw new Error("offline transport must not be used"); },
  });

  const result = await manager.ensure({ agentDir: source.agentDir });

  assert.equal(result.python, python);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ options }) => options.inheritedFds === undefined), true);
});

test("setup rejects redirects outside approved HTTPS release hosts", async (t) => {
  const source = await fixture(t);
  const fetched = [];
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async url => { fetched.push(url); return response(null, { status: 302, location: "https://evil.example/archive" }); },
    run: async () => { throw new Error("archive processing must not start"); },
  });

  await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /unapproved location/i);
  assert.deepEqual(fetched, [JSON.parse(source.manifest).uv.platforms["linux-x64"].url]);
  assert.equal((await manager.status({ agentDir: source.agentDir })).ready, false);
});

test("setup rejects unsafe archive links before extraction", async (t) => {
  const source = await fixture(t);
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async (url) => response(url.endsWith("uv.tar.gz") ? source.uvArchive : source.pythonArchive),
    run: async (_file, args) => {
      if (args.includes("-tvzf")) return { stdout: "lrwxrwxrwx root/root 0 2026-01-01 00:00 uv/uv -> ../../outside\n", stderr: "" };
      throw new Error("unsafe archive must not be extracted");
    },
  });

  await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /unsafe link target/i);
});

test("setup rejects a corrupt download before archive processing", async (t) => {
  const source = await fixture(t);
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async () => response(Buffer.from("corrupt")),
    run: async () => { throw new Error("corrupt download must not be processed"); },
  });

  await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /checksum did not match/i);
});

test("the single setup deadline includes lock acquisition", async (t) => {
  const source = await fixture(t);
  const lockDirectory = path.join(source.agentDir, "useful-skills", "dependencies");
  await mkdir(lockDirectory, { recursive: true });
  const lease = await acquireSetupLock(path.join(lockDirectory, ".setup.lock"), {});
  t.after(() => lease.release());
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async () => { throw new Error("lock must prevent download"); },
    run: async () => { throw new Error("lock must prevent process execution"); },
    setupTimeoutMs: 25,
  });

  await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /timed out/i);
});

test("installation creates the interpreter and venv at their final versioned paths", async (t) => {
  const source = await fixture(t);
  const calls = [];
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async (url) => response(url.endsWith("uv.tar.gz") ? source.uvArchive : source.pythonArchive),
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes("-tvzf")) {
        return { stdout: "-rwxr-xr-x root/root 1 2026-01-01 00:00 uv/uv\n", stderr: "" };
      }
      if (args.includes("-xzf")) {
        const executable = path.join(options.cwd, "uv", "uv");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "");
        await chmod(executable, 0o700);
        return { stdout: "", stderr: "" };
      }
      if (args.join(" ") === "--version") {
        return { stdout: file.endsWith(path.join("uv", "uv")) ? "uv 0.12.17 (x86_64-unknown-linux-gnu)\n" : "Python 3.12.14\n", stderr: "" };
      }
      if (args.includes("python") && args.includes("install")) {
        const python = path.join(args.at(-1), "cpython-3.12.14-test", "bin", "python3.12");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("venv")) {
        const python = path.join(args.at(-1), "bin", "python");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
        return { stdout: "", stderr: "" };
      }
      return { stdout: args.includes("-I") ? "0.9.65\n" : "", stderr: "" };
    },
  });

  const result = await manager.ensure({ agentDir: source.agentDir });
  const pythonInstall = calls.find(({ args }) => args.includes("python") && args.includes("install"));
  const venv = calls.find(({ args }) => args.includes("venv"));

  assert.equal(pythonInstall.args.at(-1), path.join(result.versionRoot, "python"));
  assert.match(pythonInstall.options.env.UV_PYTHON_INSTALL_MIRROR, /^file:/);
  assert.equal(venv.args.at(-1), path.join(result.versionRoot, "venv"));
  assert.equal(result.python, path.join(result.versionRoot, "venv", "bin", "python"));
});

test("setup-mutating subprocesses inherit the lease through a bounded timeout wrapper", async (t) => {
  const source = await fixture(t);
  const calls = [];
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async (url) => response(url.endsWith("uv.tar.gz") ? source.uvArchive : source.pythonArchive),
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes("-tvzf")) return { stdout: "-rwxr-xr-x root/root 1 2026-01-01 00:00 uv/uv\n", stderr: "" };
      if (args.includes("-xzf")) {
        const executable = path.join(options.cwd, "uv", "uv");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "");
        await chmod(executable, 0o700);
        return { stdout: "", stderr: "" };
      }
      if (args.join(" ") === "--version") {
        return { stdout: file.endsWith(path.join("uv", "uv")) ? "uv 0.12.17 (x86_64-unknown-linux-gnu)\n" : "Python 3.12.14\n", stderr: "" };
      }
      if (args.includes("python") && args.includes("install")) {
        const python = path.join(args.at(-1), "cpython-3.12.14-test", "bin", "python3.12");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("venv")) {
        const python = path.join(args.at(-1), "bin", "python");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
        return { stdout: "", stderr: "" };
      }
      return { stdout: args.includes("-I") ? "0.9.65\n" : "", stderr: "" };
    },
  });

  await manager.ensure({ agentDir: source.agentDir });
  const writers = calls.filter(({ file }) => file === "/usr/bin/timeout");
  assert.equal(writers.length, 4);
  assert.equal(writers.every(({ args }) => args[0] === "--kill-after=1s" && args[2].startsWith("/")), true);
  assert.equal(writers.every(({ options }) => options.inheritedFds?.length === 1), true);
  assert.deepEqual(writers.map(({ args }) => args[1]), ["30s", "600s", "60s", "600s"]);
  assert.equal(new Set(writers.map(({ options }) => options.inheritedFds[0])).size, 1);
  assert.equal(writers[0].args[2], "/usr/bin/tar");
  assert.equal(writers.slice(1).every(({ args }) => args[2].endsWith(path.join("uv", "uv"))), true);
});
