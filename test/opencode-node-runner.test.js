import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await mkdir(path.dirname(target), { recursive: true });
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

/** Kill `pid` after the test if it is still running, so a failed assertion leaks nothing. */
function reap(t, pid) {
  t.after(() => {
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  });
}

function runtimes() {
  return [["node", process.execPath], ["bun", bunPath()]];
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

// signal-exit v4, as Bun installed it for a package that depends on it; the tests that load it skip without it.
function signalExitModule() {
  const cache = path.join(os.homedir(), ".bun", "install", "cache");
  const name = existsSync(cache) ? readdirSync(cache).find(entry => entry.startsWith("signal-exit@4.")) : undefined;
  const file = name ? path.join(cache, name, "dist", "mjs", "index.js") : undefined;
  return file && existsSync(file) ? file : undefined;
}

// Registers a signal-exit handler before the subprocess starts or after it is running, optionally together with the
// host's own SIGTERM handler, and writes `<pid file>.ready` once everything is in place.
const SIGNAL_EXIT_HOST = signalExit => [
  "import { existsSync, writeFileSync } from 'node:fs';",
  `import { runNode } from ${RUNNER};`,
  `import { onExit } from ${JSON.stringify(pathToFileURL(signalExit ?? "/").href)};`,
  "const [script, pidFile, marker, order] = process.argv.slice(2);",
  "const register = () => onExit(() => { writeFileSync(marker, 'ran'); });",
  "if (order === 'before') register();",
  "runNode(script, [pidFile]).catch(() => {});",
  "const ready = setInterval(() => {",
  "  if (!existsSync(pidFile)) return;",
  "  clearInterval(ready);",
  "  if (order !== 'before') register();",
  "  if (order === 'host-exit') process.on('SIGTERM', () => process.exit(7));",
  "  writeFileSync(pidFile + '.ready', '');",
  "}, 25);",
  "setInterval(() => {}, 1_000);",
].join("\n");

const SIGNAL_EXIT_CASES = [
  ["registered before the subprocess starts", "before", [null, "SIGTERM"]],
  ["registered while the subprocess runs", "after", [null, "SIGTERM"]],
  ["and the host's own exiting handler, registered while the subprocess runs", "host-exit", [7, null]],
];

for (const [runtime, executable] of runtimes()) {
  const signalExit = signalExitModule();
  const skip = !executable ? `${runtime} is not installed` : !signalExit && "signal-exit 4 is not in the Bun cache";

  for (const [description, order, expected] of SIGNAL_EXIT_CASES) {
    test(`a ${runtime} host with signal-exit ${description} ends its subprocess on SIGTERM and exits as signal-exit or the host decides`, { ...BOUNDED, skip }, async t => {
      const { directory, file } = await fixture(t);
      const hang = await file("hang.mjs", HANG);
      const host = await file("host.mjs", SIGNAL_EXIT_HOST(signalExit));
      const pidFile = path.join(directory, "child.pid");
      const marker = path.join(directory, "signal-exit.ran");

      const parent = spawn(executable, [host, hang, pidFile, marker, order], { stdio: "ignore" });
      const exited = once(parent, "exit");
      reap(t, parent.pid);
      const child = await pidFrom(pidFile);
      reap(t, child);
      await waitFor(() => existsSync(`${pidFile}.ready`));
      parent.kill("SIGTERM");

      assert.deepEqual(await exited, expected);
      assert.equal(await readFile(marker, "utf8"), "ran");
      await assertGone(child);
    });
  }
}

// Each import is a separate module copy, as the user and project scope plugins are.
const TWO_COPIES_HOST = [
  "import { runNode as first } from './first/opencode/node-runner.js';",
  "import { runNode as second } from './second/opencode/node-runner.js';",
  "const [script, firstPid, secondPid] = process.argv.slice(2);",
  "first(script, [firstPid]).catch(() => {});",
  "second(script, [secondPid]).catch(() => {});",
  "setInterval(() => {}, 1_000);",
].join("\n");

for (const [runtime, executable] of runtimes()) {
  const skip = executable ? false : `${runtime} is not installed`;

  test(`a ${runtime} host that loaded two copies of the runner ends the subprocesses of both on SIGTERM`, { ...BOUNDED, skip }, async t => {
    const { directory, file } = await fixture(t);
    const sources = { runner: await readFile(new URL("../opencode/node-runner.js", import.meta.url)), process: await readFile(new URL("../process.js", import.meta.url)) };
    for (const copy of ["first", "second"]) {
      await file(`${copy}/opencode/node-runner.js`, sources.runner);
      await file(`${copy}/process.js`, sources.process);
    }

    const hang = await file("hang.mjs", HANG);
    const host = await file("host.mjs", TWO_COPIES_HOST);
    const pidFiles = [path.join(directory, "first.pid"), path.join(directory, "second.pid")];

    const parent = spawn(executable, [host, hang, ...pidFiles], { stdio: "ignore" });
    const exited = once(parent, "exit");
    reap(t, parent.pid);
    const children = [await pidFrom(pidFiles[0]), await pidFrom(pidFiles[1])];
    children.forEach(child => reap(t, child));
    parent.kill("SIGTERM");

    assert.deepEqual(await exited, [null, "SIGTERM"]);
    await assertGone(children[0]);
    await assertGone(children[1]);
  });
}

// Starts a process in a session of its own that keeps this script's output open, writes its pid to argv[2], and
// prints "done"; with argv[3] "hang" the script then keeps running.
const OUTPUT_HOLDER = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6_000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
  "holder.unref();",
  "writeFileSync(process.argv[2], String(holder.pid));",
  "process.stdout.write('done');",
  "if (process.argv[3] === 'hang') setTimeout(() => {}, 20_000);",
].join("\n");

test("terminating a run scope does not wait for a process outside the group that holds the output open", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", OUTPUT_HOLDER);
  const pidFile = path.join(directory, "holder.pid");

  const scope = createRunScope();
  const stopped = scope.run(entry, [pidFile, "hang"]);
  const holder = await pidFrom(pidFile);
  reap(t, holder);

  const started = Date.now();
  await scope.terminate();
  await assert.rejects(stopped, /stopped/);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(alive(holder), true);
});

test("a finished run returns its output without waiting for a process outside the group that holds it open", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", OUTPUT_HOLDER);
  const pidFile = path.join(directory, "holder.pid");

  const started = Date.now();
  const result = await runNode(entry, [pidFile]);
  reap(t, await pidFrom(pidFile));

  assert.deepEqual(result, { exitCode: 0, stdout: "done", stderr: "" });
  assert.ok(Date.now() - started < 3_000);
});

// An entry point whose event loop is blocked once its separately grouped runProcess grandchild has started, so its
// own SIGTERM handler (exitOnTermination) never runs.
const BLOCKED_ENTRY = [
  `import { exitOnTermination, runProcess } from ${PROCESS};`,
  "import { existsSync } from 'node:fs';",
  "exitOnTermination();",
  "const hang = `require('node:fs').writeFileSync(${JSON.stringify(process.argv[2])}, String(process.pid)); setTimeout(() => {}, 20_000);`;",
  "runProcess(process.execPath, ['-e', hang], { cwd: process.cwd(), env: {}, timeoutMs: 60_000 }).catch(() => {});",
  "const started = setInterval(() => {",
  "  if (!existsSync(process.argv[2])) return;",
  "  clearInterval(started);",
  "  const end = Date.now() + 5_000;",
  "  while (Date.now() < end);",
  "}, 10);",
].join("\n");

test("a runNode timeout ends the separately grouped grandchild even when the script is too busy to end it", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", BLOCKED_ENTRY);
  const pidFile = path.join(directory, "grandchild.pid");

  await assert.rejects(runNode(entry, [pidFile], { cwd: directory, timeoutMs: 1_000 }), /did not finish/);
  const grandchild = await pidFrom(pidFile);
  reap(t, grandchild);
  await assertGone(grandchild);
});

test("the location where a script records its process groups is private to the run and removed after it", BOUNDED, async t => {
  const { file } = await fixture(t);
  const entry = await file("entry.mjs", [
    "import { statSync } from 'node:fs';",
    "import path from 'node:path';",
    "const record = process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE;",
    "process.stdout.write(JSON.stringify({ record, mode: statSync(path.dirname(record)).mode & 0o777 }));",
  ].join("\n"));

  const { stdout } = await runNode(entry);
  const { record, mode } = JSON.parse(stdout);

  assert.equal(mode, 0o700);
  assert.equal(existsSync(path.dirname(record)), false);
});

test("a run goes ahead without a process group record when the temporary directory is unusable", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", "process.stdout.write(String(process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE));");

  const temporary = process.env.TMPDIR;
  process.env.TMPDIR = path.join(directory, "missing");
  const result = await runNode(entry).finally(() => {
    if (temporary === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = temporary;
    }
  });

  assert.deepEqual(result, { exitCode: 0, stdout: "undefined", stderr: "" });
});

// Forges entries naming its host's process group, malformed or not, in its record, then hangs until timed out.
const FORGING_ENTRY = [
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync(process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE, `+${process.ppid}\\n+${process.ppid}x\\n+0\\n+1\\n`);",
  "setTimeout(() => {}, 20_000);",
].join("\n");

test("a run never signals its host's own process group, whatever its script records", BOUNDED, async t => {
  const { file } = await fixture(t);
  const entry = await file("entry.mjs", FORGING_ENTRY);
  const host = await file("host.mjs", [
    `import { runNode } from ${RUNNER};`,
    "runNode(process.argv[2], [], { timeoutMs: 500 }).catch(error => process.stdout.write(error.message));",
  ].join("\n"));

  // The host leads a process group of its own, so the forged entry names exactly that group.
  const parent = spawn(process.execPath, [host, entry], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  reap(t, parent.pid);
  let output = "";
  parent.stdout.on("data", chunk => {
    output += chunk;
  });

  assert.deepEqual(await once(parent, "exit"), [0, null]);
  assert.match(output, /did not finish/);
});

test("a host whose signal-exit reports a negative listener count still dies by SIGTERM", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const hang = await file("hang.mjs", HANG);
  const host = await file("host.mjs", [
    `import { runNode } from ${RUNNER};`,
    "process.__signal_exit_emitter__ = { count: -1 };",
    "runNode(process.argv[2], [process.argv[3]]).catch(() => {});",
    "setTimeout(() => process.exit(9), 5_000);",
  ].join("\n"));
  const pidFile = path.join(directory, "child.pid");

  const parent = spawn(process.execPath, [host, hang, pidFile], { stdio: "ignore" });
  const exited = once(parent, "exit");
  reap(t, parent.pid);
  const child = await pidFrom(pidFile);
  reap(t, child);
  parent.kill("SIGTERM");

  assert.deepEqual(await exited, [null, "SIGTERM"]);
  await assertGone(child);
});

// Like OUTPUT_HOLDER, but also writes its own pid to argv[3] and exits at once.
const DRAINING_ENTRY = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6_000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
  "holder.unref();",
  "writeFileSync(process.argv[2], String(holder.pid));",
  "writeFileSync(process.argv[3], String(process.pid));",
  "process.stdout.write('done');",
].join("\n");

test("aborting a run after its script exited, while its output drains, keeps the result", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", DRAINING_ENTRY);
  const [holderFile, entryFile] = [path.join(directory, "holder.pid"), path.join(directory, "entry.pid")];

  const controller = new AbortController();
  const result = runNode(entry, [holderFile, entryFile], { signal: controller.signal });
  reap(t, await pidFrom(holderFile));
  const script = await pidFrom(entryFile);
  // Node reaps the script and emits its exit together, so once it is gone the run is draining.
  await assertGone(script);
  controller.abort();

  assert.deepEqual(await result, { exitCode: 0, stdout: "done", stderr: "" });
});

test("a timeout while a finished run's output drains keeps the result", BOUNDED, async t => {
  const { directory, file } = await fixture(t);
  const entry = await file("entry.mjs", DRAINING_ENTRY);
  const [holderFile, entryFile] = [path.join(directory, "holder.pid"), path.join(directory, "entry.pid")];

  const started = Date.now();
  const result = await runNode(entry, [holderFile, entryFile], { timeoutMs: 700 });
  reap(t, await pidFrom(holderFile));

  assert.deepEqual(result, { exitCode: 0, stdout: "done", stderr: "" });
  // The run settled only after the timeout had passed.
  assert.ok(Date.now() - started > 700);
});
