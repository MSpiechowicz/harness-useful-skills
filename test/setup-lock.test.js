import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { acquireSetupLock } from "../setup-lock.js";
import { createLockedRunner } from "../setup-runner.js";
import { runProcess } from "../process.js";

async function lockFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-setup-lock-"));
  const directory = path.join(root, "dependencies");
  const lockFile = path.join(directory, ".setup.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { lockFile };
}

async function waitForOutput(child, expected) {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes(expected)) return output;
  }
  throw new Error(`Lock holder exited before writing ${expected}.`);
}

async function waitForFile(file) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Orphan writer did not start: ${file}`);
}

async function waitForProcessGroupExit(pid) {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    try {
      process.kill(-pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Orphan writer process group did not terminate: ${pid}`);
}

function abruptHolder(lockFile) {
  const lockModule = pathToFileURL(path.resolve(import.meta.dirname, "../setup-lock.js")).href;
  const source = [
    `import { acquireSetupLock } from ${JSON.stringify(lockModule)};`,
    "const lease = await acquireSetupLock(process.argv.at(-1), {});",
    'process.stdout.write(`locked:${lease.fd}\\n`);',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  return spawn(process.execPath, ["--input-type=module", "--eval", source, lockFile], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function crashingCoordinator(lockFile, writerReadyFile) {
  const lockModule = pathToFileURL(path.resolve(import.meta.dirname, "../setup-lock.js")).href;
  const source = [
    'import { spawn } from "node:child_process";',
    `import { acquireSetupLock } from ${JSON.stringify(lockModule)};`,
    "const lease = await acquireSetupLock(process.argv.at(-2), {});",
    "const writer = spawn(\"/usr/bin/timeout\", [\"--kill-after=1s\", \"0.5s\", process.execPath, \"--input-type=module\", \"--eval\",",
    "  'import { writeFile } from \"node:fs/promises\"; await writeFile(process.argv.at(-1), \"started\"); process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1_000);', process.argv.at(-1)],",
    "  { detached: true, stdio: [\"ignore\", \"ignore\", \"ignore\", lease.fd] });",
    "writer.unref();",
    'process.stdout.write(`writer:${writer.pid}\\n`);',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  return spawn(process.execPath, ["--input-type=module", "--eval", source, lockFile, writerReadyFile], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("a lock becomes acquirable after an abrupt holder exit", async (t) => {
  const { lockFile } = await lockFixture(t);
  const holder = abruptHolder(lockFile);
  t.after(() => holder.kill("SIGKILL"));
  await waitForOutput(holder, "locked:");
  holder.kill("SIGKILL");
  await once(holder, "close");

  const lease = await acquireSetupLock(lockFile, { signal: AbortSignal.timeout(1_000) });
  await lease.release();
});

test("an orphaned writer retains the coordinator lock until its bounded work exits", async (t) => {
  const { lockFile } = await lockFixture(t);
  const writerReadyFile = `${lockFile}.writer-ready`;
  const coordinator = crashingCoordinator(lockFile, writerReadyFile);
  let writerPid;
  t.after(() => {
    coordinator.kill("SIGKILL");
    if (writerPid) {
      try {
        process.kill(-writerPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  });

  const output = await waitForOutput(coordinator, "writer:");
  writerPid = Number(output.match(/writer:(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(writerPid) && writerPid > 0);
  coordinator.kill("SIGKILL");
  await once(coordinator, "close");
  assert.doesNotThrow(() => process.kill(writerPid, 0));

  assert.equal(await waitForFile(writerReadyFile), "started");
  await assert.rejects(acquireSetupLock(lockFile, { timeoutMs: 100 }), /timed out/i);
  await waitForProcessGroupExit(writerPid);
  const lease = await acquireSetupLock(lockFile, { signal: AbortSignal.timeout(1_000) });
  await lease.release();
});

test("cancelling a waiter leaves a live owner in control of the lock", async (t) => {
  const { lockFile } = await lockFixture(t);
  const owner = await acquireSetupLock(lockFile, {});
  t.after(() => owner.release());
  const controller = new AbortController();
  const cancellation = new Error("cancel setup waiting for lock");
  const timer = setTimeout(() => controller.abort(cancellation), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(acquireSetupLock(lockFile, { signal: controller.signal }), (error) => error === cancellation);
  await assert.rejects(acquireSetupLock(lockFile, { timeoutMs: 25 }), /timed out/i);

  await owner.release();
  const next = await acquireSetupLock(lockFile, { signal: AbortSignal.timeout(1_000) });
  await next.release();
});

test("a blocked advisory waiter has a bounded ownership timeout", async (t) => {
  const { lockFile } = await lockFixture(t);
  const owner = await acquireSetupLock(lockFile, {});
  t.after(() => owner.release());
  await assert.rejects(acquireSetupLock(lockFile, { timeoutMs: 25 }), /timed out after 25ms/i);
});

test("a pre-existing unlocked lock file is safely reused by a frozen idempotent lease", async (t) => {
  const { lockFile } = await lockFixture(t);
  await writeFile(lockFile, "prior setup metadata", { mode: 0o600 });
  const lease = await acquireSetupLock(lockFile, { signal: AbortSignal.timeout(1_000) });
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Number.isSafeInteger(lease.fd), true);
  await Promise.all([lease.release(), lease.release()]);
});

test("pre-cancelled acquisition creates no lock file", async (t) => {
  const { lockFile } = await lockFixture(t);
  await assert.rejects(acquireSetupLock(lockFile, { signal: AbortSignal.abort("stop") }), /cancelled/i);
  await assert.rejects(lstat(lockFile), { code: "ENOENT" });
});

test("malformed lock arguments fail before opening a descriptor", async (t) => {
  const { lockFile } = await lockFixture(t);
  await assert.rejects(acquireSetupLock("relative.lock"), /absolute path/i);
  await assert.rejects(acquireSetupLock(lockFile, { signal: {} }), /AbortSignal/);
  await assert.rejects(acquireSetupLock(lockFile, { timeoutMs: 0 }), /positive safe integer/i);
  await assert.rejects(lstat(lockFile), { code: "ENOENT" });
});

test("a symlinked lock parent cannot redirect setup ownership", async (t) => {
  const { lockFile } = await lockFixture(t);
  const root = path.dirname(path.dirname(lockFile));
  const target = path.join(root, "target");
  const link = path.join(root, "linked");
  await mkdir(target);
  await symlink(target, link);
  await assert.rejects(acquireSetupLock(path.join(link, ".setup.lock")), /real directory/i);
  assert.deepEqual(await readdir(target), []);
});

test("a lock-file symlink cannot modify its target", async (t) => {
  const { lockFile } = await lockFixture(t);
  const target = path.join(path.dirname(lockFile), "unrelated");
  await writeFile(target, "preserve this content", { mode: 0o644 });
  await symlink(target, lockFile);
  await assert.rejects(acquireSetupLock(lockFile), /regular file.*symlink/i);
  assert.equal(await readFile(target, "utf8"), "preserve this content");
  assert.equal((await lstat(target)).mode & 0o777, 0o644);
});

test("a directory cannot masquerade as the advisory lock file", async (t) => {
  const { lockFile } = await lockFixture(t);
  await mkdir(lockFile);
  await assert.rejects(acquireSetupLock(lockFile), /regular file/i);
  assert.deepEqual(await readdir(lockFile), []);
});

test("locked execution rejects invalid capabilities and unbounded deadlines before launch", () => {
  assert.throws(() => createLockedRunner(null, { fd: 0 }), /run must be a function/);
  assert.throws(() => createLockedRunner(runProcess, {}), /file descriptor/);
  assert.throws(() => createLockedRunner(runProcess, { fd: -1 }), /file descriptor/);
  const run = createLockedRunner(runProcess, { fd: 0 });
  assert.throws(() => run("/not/launched", [], { timeoutMs: 0 }), /positive safe integer/);
});
