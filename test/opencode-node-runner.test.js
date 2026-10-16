import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createRunScope, runNode } from "../opencode/node-runner.js";

// Every case waits on subprocesses, so a regression fails fast instead of hanging the run.
const BOUNDED = { timeout: 10_000 };

const RUNNER = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../opencode/node-runner.js")).href);
const PROCESS = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../process.js")).href);

// Writes its pid to argv[2], then hangs; it exits on its own after a while, so a failed test leaks nothing for long.
const HANG = "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 20_000);";

// A Useful Skills entry point: starts a separately grouped runProcess grandchild that writes its pid to argv[2].
const ENTRY = [
  `import { exitOnTermination, runProcess } from ${PROCESS};`,
  "exitOnTermination();",
  "const hang = `require('node:fs').writeFileSync(${JSON.stringify(process.argv[2])}, String(process.pid)); setTimeout(() => {}, 20_000);`;",
  "await runProcess(process.execPath, ['-e', hang], { cwd: process.cwd(), env: {}, timeoutMs: 60_000 }).catch(() => {});",
].join("\n");

function bunPath() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return "bun";
  } catch {
    return undefined;
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-node-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = async (name, text) => {
    const target = path.join(directory, name);
    await writeFile(target, text);
    return target;
  };
  return { directory, file };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("The condition was not met in time.");
}

async function pidFrom(file) {
  await waitFor(() => existsSync(file));
  await waitFor(async () => (await readFile(file, "utf8")).length > 0);
  return Number(await readFile(file, "utf8"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function assertGone(pid) {
  await waitFor(() => !alive(pid));
}

test("a runNode timeout also ends the grandchild that the script started in a process group of its own", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", ENTRY);
  const pidFile = path.join(directory, "grandchild.pid");

  const started = Date.now();
  await assert.rejects(runNode(entry, [pidFile], { cwd: directory, timeoutMs: 1_500 }), /did not finish/);
  assert.ok(Date.now() - started < 4_000);
  await assertGone(await pidFrom(pidFile));
});

test("a host killed by SIGTERM ends its subprocesses and still dies by that signal", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const hang = await file("hang.mjs", HANG);
  const host = await file("host.mjs", [
    `import { runNode } from ${RUNNER};`,
    "runNode(process.argv[2], [process.argv[3]]).catch(() => {});",
    "setInterval(() => {}, 1_000);",
  ].join("\n"));
  const pidFile = path.join(directory, "child.pid");

  const parent = spawn(process.execPath, [host, hang, pidFile], { stdio: "ignore" });
  const exited = once(parent, "exit");
  const child = await pidFrom(pidFile);
  parent.kill("SIGTERM");

  assert.deepEqual(await exited, [null, "SIGTERM"]);
  await assertGone(child);
});

test("a host with its own SIGTERM handler keeps it, and its exit still ends the subprocesses", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const hang = await file("hang.mjs", HANG);
  const host = await file("host.mjs", [
    `import { runNode } from ${RUNNER};`,
    "process.on('SIGTERM', () => process.exit(7));",
    "runNode(process.argv[2], [process.argv[3]]).catch(() => {});",
    "setInterval(() => {}, 1_000);",
  ].join("\n"));
  const pidFile = path.join(directory, "child.pid");

  const parent = spawn(process.execPath, [host, hang, pidFile], { stdio: "ignore" });
  const exited = once(parent, "exit");
  const child = await pidFrom(pidFile);
  parent.kill("SIGTERM");

  assert.deepEqual(await exited, [7, null]);
  await assertGone(child);
});

test("terminating a run scope stops only its own subprocesses and refuses new ones", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const hang = await file("hang.mjs", HANG);
  const scoped = path.join(directory, "scoped.pid");
  const other = path.join(directory, "other.pid");

  const scope = createRunScope();
  const outside = createRunScope();
  const stopped = scope.run(hang, [scoped]);
  const running = outside.run(hang, [other]);
  const [scopedPid, otherPid] = [await pidFrom(scoped), await pidFrom(other)];

  await scope.terminate();
  await assert.rejects(stopped, /stopped/);
  assert.equal(alive(scopedPid), false);
  assert.equal(alive(otherPid), true);
  await assert.rejects(scope.run(hang, [scoped]), /stopped/);

  await outside.terminate();
  await assert.rejects(running, /stopped/);
  assert.equal(alive(otherPid), false);
});

// The OpenCode TUI hosts plugins in a Worker it terminates after disposing them, with no exit event inside it.
const WORKER_HOST = [
  "import { Worker } from 'node:worker_threads';",
  "const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: process.argv.slice(2) });",
  "worker.on('message', async message => { if (message === 'stopped') { await worker.terminate(); process.exit(0); } });",
].join("\n");

const WORKER = [
  "import { parentPort, workerData } from 'node:worker_threads';",
  `import { createRunScope } from ${RUNNER};`,
  "import { existsSync } from 'node:fs';",
  "const [script, pidFile] = workerData;",
  "const scope = createRunScope();",
  "scope.run(script, [pidFile]).catch(() => {});",
  "const ready = setInterval(async () => {",
  "  if (!existsSync(pidFile)) return;",
  "  clearInterval(ready);",
  "  await scope.terminate();",
  "  parentPort.postMessage('stopped');",
  "}, 25);",
].join("\n");

for (const runtime of ["node", "bun"]) {
  const executable = runtime === "node" ? process.execPath : bunPath();

  const skip = executable ? false : "bun is not installed";
  test(`a ${runtime} Worker host that disposes its run scope before terminating the Worker leaves no subprocess`, { ...BOUNDED, skip }, async t => {
    const { directory, file } = await fixture(t);
    const hang = await file("hang.mjs", HANG);
    const host = await file("host.mjs", WORKER_HOST);
    await file("worker.mjs", WORKER);
    const pidFile = path.join(directory, "child.pid");

    const parent = spawn(executable, [host, hang, pidFile], { stdio: "ignore" });
    const [code] = await once(parent, "exit");

    assert.equal(code, 0);
    assert.equal(alive(await pidFrom(pidFile)), false);
  });
}
