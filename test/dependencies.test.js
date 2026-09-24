import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireSetupLock } from "../setup-lock.js";
import { createDependencyManager, dependencyStatus } from "../dependencies.js";
import { runProcess } from "../process.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const dependenciesRoot = path.join(repositoryRoot, "dependencies");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function dependencyLockHash(manifest, lock) {
  const original = JSON.parse(manifest);
  if (original.uv.platforms["darwin-arm64"]) {
    delete original.uv.platforms["darwin-arm64"];
    delete original.python.platforms["darwin-arm64"];
    const indent = manifest.toString().match(/\n([ \t]+)"schemaVersion"/)?.[1] ?? "";
    manifest = Buffer.from(JSON.stringify(original, null, indent) + (manifest.at(-1) === 10 ? "\n" : ""));
  }
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

function simulateDarwinLockf(file, args, options) {
  assert.equal(file, "/usr/bin/lockf");
  assert.deepEqual(args, ["-s", "-t", String(Math.ceil((options.timeoutMs - 250) / 1_000)), "3"]);
  assert.equal(options.inheritedFds.length, 1);
  return runProcess("/usr/bin/flock", [
    "--exclusive", "--timeout", String((options.timeoutMs - 250) / 1_000),
    "--conflict-exit-code", "75", "3",
  ], options);
}


async function darwinFixture(t) {
  const source = await fixture(t);
  const manifest = JSON.parse(source.manifest);
  manifest.uv.platforms["darwin-arm64"] = {
    url: "https://github.com/example/darwin-uv.tar.gz",
    sha256: sha256(source.uvArchive),
    archive: "tar.gz",
    executable: "uv-aarch64-apple-darwin/uv",
  };
  manifest.python.platforms["darwin-arm64"] = {
    url: "https://github.com/example/darwin-python.tar.gz",
    sha256: sha256(source.pythonArchive),
    mirror: "https://github.com/example",
    archive: "cpython-3.12.14+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz",
  };
  await writeFile(path.join(source.dependencyRoot, "manifest.json"), JSON.stringify(manifest));
  return source;
}
test("dependency status is read-only when no profile state exists", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "useful-skills-dependencies-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const agentDir = path.join(parent, "missing-profile");

  const result = await dependencyStatus({ agentDir });

  assert.equal(result.ready, false);
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
});

test("Darwin ARM64 dependency status is read-only and reports a managed target", async (t) => {
  const source = await fixture(t);
  const result = await createDependencyManager({
    dependenciesRoot,
    platform: "darwin",
    arch: "arm64",
  }).status({ agentDir: source.agentDir });
  assert.equal(result.platform, "darwin-arm64");
  assert.equal(result.state, "missing");
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
});

test("adding Darwin metadata retains the pre-existing Linux installation identity", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "useful-skills-cache-key-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const status = await dependencyStatus({ agentDir });
  assert.equal(status.lockHash, "cef1866e1184ad64821a75807128d758254ff84056ec8b0de43d0c61d6d40500");
});

test("unsupported targets fail before setup creates profile storage", async (t) => {
  const source = await fixture(t);
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    const manager = createDependencyManager({ dependenciesRoot, platform, arch });
    assert.equal((await manager.status({ agentDir: source.agentDir })).state, "unsupported");
    await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /unsupported/i);
  }
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
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
    run: async (file, args, options) => {
      if (file === "/usr/bin/flock") return runProcess(file, args, options);
      throw new Error("archive processing must not start");
    },
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
    run: async (file, args, options) => {
      if (file === "/usr/bin/flock") return runProcess(file, args, options);
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
    run: async (file, args, options) => {
      if (file === "/usr/bin/flock") return runProcess(file, args, options);
      throw new Error("corrupt download must not be processed");
    },
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
    run: async (file, args, options) => {
      if (file === "/usr/bin/flock") return runProcess(file, args, options);
      throw new Error("lock must prevent process execution");
    },
    setupTimeoutMs: 25,
  });

  await assert.rejects(manager.ensure({ agentDir: source.agentDir }), /timed out/i);
});

test("installation creates the interpreter and venv at their final versioned paths", async (t) => {
  const source = await fixture(t);
  const calls = [];
  let uvOutput = "uv 0.12.17 (x86_64-unknown-linux-gnu)\n";
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    fetch: async (url) => response(url.endsWith("uv.tar.gz") ? source.uvArchive : source.pythonArchive),
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === "/usr/bin/flock") return runProcess(file, args, options);
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
        return { stdout: file.endsWith(path.join("uv", "uv")) ? uvOutput : "Python 3.12.14\n", stderr: "" };
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
  uvOutput = "uv 0.12.17 (8f3a12bc 2026-09-01 x86_64-unknown-linux-gnu)\n";
  const releaseProfile = path.join(source.agentDir, "release-style");
  const releaseResult = await manager.ensure({ agentDir: releaseProfile });
  assert.equal(releaseResult.python, path.join(releaseResult.versionRoot, "venv", "bin", "python"));
  assert.equal((await manager.status({ agentDir: releaseProfile })).ready, true);
});

test("Darwin manager installs from pinned mirror and reuses healthy setup offline (Linux-host simulation)", async (t) => {
  const source = await darwinFixture(t);
  let uvOutput = "uv 0.12.17 (8f3a12bc 2026-09-01 aarch64-apple-darwin)\n";
  let offline = false;
  const manager = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    platform: "darwin",
    arch: "arm64",
    fetch: async (url) => {
      if (offline) throw new Error("Healthy Darwin installation must reuse offline.");
      return response(url.includes("darwin-uv") ? source.uvArchive : source.pythonArchive);
    },
    run: async (file, args, options) => {
      if (file === "/usr/bin/lockf") return simulateDarwinLockf(file, args, options);
      if (args.includes("-tvzf")) return { stdout: "-rwxr-xr-x  0 user staff 123 Sep  1 12:34 uv-aarch64-apple-darwin/uv\n" };
      if (args.includes("-xozf")) {
        const executable = path.join(options.cwd, "uv-aarch64-apple-darwin", "uv");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "");
        return { stdout: "" };
      }
      if (args.join(" ") === "--version") return { stdout: file.endsWith("darwin/uv") ? uvOutput : "Python 3.12.14\n" };
      if (args.includes("python") && args.includes("install")) {
        const mirror = new URL(options.env.UV_PYTHON_INSTALL_MIRROR);
        const mirroredArchive = path.join(mirror.pathname, "20260901",
          "cpython-3.12.14+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz");
        assert.deepEqual(await readFile(mirroredArchive), source.pythonArchive);
        const python = path.join(args.at(-1), "cpython-3.12.14-test", "bin", "python3.12");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
      }
      if (args.includes("venv")) {
        const python = path.join(args.at(-1), "bin", "python");
        await mkdir(path.dirname(python), { recursive: true });
        await writeFile(python, "");
      }
      return { stdout: args.includes("-I") ? "0.9.65\n" : "" };
    },
  });
  const result = await manager.ensure({ agentDir: source.agentDir });
  assert.equal((await manager.status({ agentDir: source.agentDir })).ready, true);
  assert.equal(result.python, path.join(result.versionRoot, "venv", "bin", "python"));
  offline = true;
  await manager.ensure({ agentDir: source.agentDir });
  assert.equal((await manager.status({ agentDir: source.agentDir })).ready, true);
  offline = false;
  uvOutput = "uv 0.12.17 (aarch64-apple-darwin)\n";
  const metadataFreeProfile = path.join(source.agentDir, "metadata-free");
  const plainResult = await manager.ensure({ agentDir: metadataFreeProfile });
  assert.equal(plainResult.python, path.join(plainResult.versionRoot, "venv", "bin", "python"));
  assert.equal((await manager.status({ agentDir: metadataFreeProfile })).ready, true);
  offline = true;
  await manager.ensure({ agentDir: metadataFreeProfile });
});

test("Darwin archive listings reject traversal, escaping links and unknown formats before extraction", async (t) => {
  const source = await darwinFixture(t);
  const listings = [
    ["-rw-r--r--  0 user staff 123 Sep  1 12:34 ../outside\n", /unsafe path/i],
    ["lrwxr-xr-x  0 user staff 0 Sep  1 12:34 uv-aarch64-apple-darwin/uv -> ../../outside\n", /unsafe link target/i],
    ["unexpected listing\n", /unsupported entry format/i],
  ];
  for (const [listing, error] of listings) {
    const manager = createDependencyManager({
      dependenciesRoot: source.dependencyRoot,
      platform: "darwin",
      arch: "arm64",
      fetch: async () => response(source.uvArchive),
      run: async (file, args, options) => {
        if (file === "/usr/bin/lockf") return simulateDarwinLockf(file, args, options);
        if (args.includes("-tvzf")) return { stdout: listing };
        throw new Error("unsafe archive must not be extracted");
      },
    });
    await assert.rejects(manager.ensure({ agentDir: source.agentDir }), error);
  }
  assert.equal((await createDependencyManager({
    dependenciesRoot: source.dependencyRoot, platform: "darwin", arch: "arm64",
  }).status({ agentDir: source.agentDir })).ready, false);
});

test("Darwin manifest and invalid uv version output fail before Python preparation", async (t) => {
  const source = await darwinFixture(t);
  const metadata = JSON.parse(await readFile(path.join(source.dependencyRoot, "manifest.json")));
  metadata.python.platforms["darwin-arm64"].sha256 = "invalid";
  await writeFile(path.join(source.dependencyRoot, "manifest.json"), JSON.stringify(metadata));
  const manager = createDependencyManager({ dependenciesRoot: source.dependencyRoot, platform: "darwin", arch: "arm64" });
  await assert.rejects(manager.status({ agentDir: source.agentDir }), /metadata is invalid/i);
  await assert.rejects(stat(source.agentDir), { code: "ENOENT" });
  metadata.python.platforms["darwin-arm64"].sha256 = sha256(source.pythonArchive);
  await writeFile(path.join(source.dependencyRoot, "manifest.json"), JSON.stringify(metadata));
  let uvOutput;
  const fetched = [];
  const mismatched = createDependencyManager({
    dependenciesRoot: source.dependencyRoot,
    platform: "darwin",
    arch: "arm64",
    fetch: async (url) => {
      fetched.push(url);
      if (url !== metadata.uv.platforms["darwin-arm64"].url) throw new Error("Invalid uv output must not prepare Python");
      return response(source.uvArchive);
    },
    run: async (file, args, options) => {
      if (file === "/usr/bin/lockf") return simulateDarwinLockf(file, args, options);
      if (args.includes("-tvzf")) return { stdout: "-rwxr-xr-x  0 user staff 123 Sep  1 12:34 uv-aarch64-apple-darwin/uv\n" };
      if (args.includes("-xozf")) {
        const target = path.join(options.cwd, "uv-aarch64-apple-darwin", "uv");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "");
        return { stdout: "" };
      }
      if (args.join(" ") === "--version") return { stdout: uvOutput };
      throw new Error("Invalid uv output must not prepare Python");
    },
  });
  for (const [reason, output] of [
    ["wrong target", "uv 0.12.17 (8f3a12bc 2026-09-01 x86_64-unknown-linux-gnu)\n"],
    ["wrong version", "uv 0.12.18 (8f3a12bc 2026-09-01 aarch64-apple-darwin)\n"],
    ["development suffix", "uv 0.12.17+1 (8f3a12bc 2026-09-01 aarch64-apple-darwin)\n"],
    ["non-hex commit", "uv 0.12.17 (nothex 2026-09-01 aarch64-apple-darwin)\n"],
    ["missing date", "uv 0.12.17 (8f3a12bc aarch64-apple-darwin)\n"],
    ["malformed date", "uv 0.12.17 (8f3a12bc 2026/09/01 aarch64-apple-darwin)\n"],
    ["trailing output", "uv 0.12.17 (8f3a12bc 2026-09-01 aarch64-apple-darwin)\nextra\n"],
  ]) {
    uvOutput = output;
    fetched.length = 0;
    await assert.rejects(mismatched.ensure({ agentDir: source.agentDir }), /uv version did not match/i, reason);
    assert.deepEqual(fetched, [metadata.uv.platforms["darwin-arm64"].url], reason);
  }
});
