import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runNode } from "../opencode/node-runner.js";
import { minimalEnvironment, recordedProcessGroups, runProcess } from "../process.js";

test("minimal environment retains only owned runtime locations", () => {
  const environment = minimalEnvironment({
    home: "/owned/home",
    cache: "/owned/cache",
    tmp: "/owned/tmp",
    pathEntries: ["/owned/bin", "/usr/bin"],
  });

  assert.deepEqual(environment, {
    HOME: "/owned/home",
    PATH: "/owned/bin:/usr/bin",
    TMPDIR: "/owned/tmp",
    UV_CACHE_DIR: "/owned/cache",
  });
});

test("process runner returns separate bounded stdout and stderr", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
    cwd: process.cwd(),
    env: minimalEnvironment({ home: "/tmp/home", cache: "/tmp/cache", tmp: "/tmp/tmp" }),
    timeoutMs: 1_000,
    maxBytes: 32,
  });

  assert.deepEqual(result, { stdout: "out", stderr: "err" });
});

test("process runner fails when an output stream exceeds its bound", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(64))"], {
      cwd: process.cwd(),
      env: minimalEnvironment({ home: "/tmp/home", cache: "/tmp/cache", tmp: "/tmp/tmp" }),
      timeoutMs: 1_000,
      maxBytes: 16,
    }),
    /output exceeded 16 bytes/i,
  );
});

test("process runner terminates on an aborted signal", async () => {
  const controller = new AbortController();
  const started = new Promise((resolve) => {
    setTimeout(() => {
      controller.abort(new Error("cancelled by test"));
      resolve();
    }, 20);
  });

  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    cwd: process.cwd(),
    env: minimalEnvironment({ home: "/tmp/home", cache: "/tmp/cache", tmp: "/tmp/tmp" }),
    timeoutMs: 1_000,
    signal: controller.signal,
    maxBytes: 32,
  });

  await started;
  await assert.rejects(result, /cancelled/i);
});

test("process runner copies frozen environments and clears ambient coverage output", async () => {
  const environment = Object.freeze({
    HOME: "/tmp/home",
    PATH: process.env.PATH ?? "/usr/bin",
    TMPDIR: "/tmp/tmp",
    UV_CACHE_DIR: "/tmp/cache",
    NODE_V8_COVERAGE: "/ambient/coverage",
  });

  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env.NODE_V8_COVERAGE))"], {
    cwd: process.cwd(),
    env: environment,
    timeoutMs: 1_000,
    maxBytes: 32,
  });

  assert.equal(result.stdout, "\"\"");
  assert.equal(environment.NODE_V8_COVERAGE, "/ambient/coverage");
});

test("process runner escalates termination after a timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], {
      cwd: process.cwd(),
      env: minimalEnvironment({ home: "/tmp/home", cache: "/tmp/cache", tmp: "/tmp/tmp" }),
      timeoutMs: 25,
      maxBytes: 32,
    }),
    /timed out/i,
  );

  assert.ok(Date.now() - startedAt < 2_000);
});

test("an entry point ended by a signal ends its process children, runs its cleanups, and exits 128 + signal", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "grandchild.pid");
  const marker = path.join(directory, "cleaned");
  const entry = path.join(directory, "entry.mjs");
  const processModule = pathToFileURL(path.resolve(import.meta.dirname, "../process.js")).href;
  await writeFile(entry, [
    "import { writeFileSync } from 'node:fs';",
    `import { exitOnTermination, onTermination, runProcess } from ${JSON.stringify(processModule)};`,
    "const [pidFile, marker] = process.argv.slice(2);",
    "exitOnTermination();",
    "onTermination(() => writeFileSync(marker, 'cleaned'));",
    "const forgotten = onTermination(() => writeFileSync(marker + '.forgotten', 'ran'));",
    "forgotten();",
    "const hang = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20_000);`;",
    "await runProcess(process.execPath, ['-e', hang], { cwd: process.cwd(), env: {}, timeoutMs: 60_000 }).catch(() => {});",
  ].join("\n"));

  const parent = spawn(process.execPath, [entry, pidFile, marker], { stdio: "ignore" });
  const exited = once(parent, "exit");
  while (!existsSync(pidFile) || (await readFile(pidFile, "utf8")) === "") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const grandchild = Number(await readFile(pidFile, "utf8"));
  parent.kill("SIGHUP");

  assert.deepEqual(await exited, [129, null]);
  assert.equal(await readFile(marker, "utf8"), "cleaned");
  assert.equal(existsSync(`${marker}.forgotten`), false);
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
});

/** A run directory as opencode/node-runner.js creates it, with `record` set as this process's record for the test. */
async function runRecord(t, record = (directory) => path.join(directory, "process-groups")) {
  const directory = await mkdtemp(path.join(realpathSync(os.tmpdir()), "useful-skills-run-"));
  const file = record(directory);
  process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE = file;
  t.after(async () => {
    delete process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE;
    await rm(directory, { recursive: true, force: true });
  });

  return { directory, record: file };
}

const QUICK = { cwd: process.cwd(), env: {}, timeoutMs: 5_000 };

test("under the OpenCode runner, runProcess records each child's process group while it runs and withholds the record from it", async (t) => {
  const { record } = await runRecord(t);

  const result = runProcess(process.execPath, ["-e", [
    "process.stdout.write(JSON.stringify([process.pid, process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE ?? null]));",
    "setTimeout(() => {}, 300);",
  ].join("\n")], {
    cwd: process.cwd(),
    env: { ...minimalEnvironment({ home: "/tmp/home", cache: "/tmp/cache", tmp: "/tmp/tmp" }), USEFUL_SKILLS_PROCESS_GROUPS_FILE: record },
    timeoutMs: 5_000,
  });

  let running = recordedProcessGroups(record);
  while (!running?.size) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    running = recordedProcessGroups(record);
  }

  const [pid, visibleRecord] = JSON.parse((await result).stdout);
  assert.deepEqual(running, new Set([pid]));
  assert.equal(visibleRecord, null);
  assert.deepEqual(recordedProcessGroups(record), new Set());
});

test("runProcess writes no record through a symlink, outside a private run directory, or at a path a script chose", async (t) => {
  const { directory } = await runRecord(t);
  const victim = path.join(directory, "victim.txt");
  await writeFile(victim, "user content\n");
  await symlink(victim, path.join(directory, "process-groups"));
  await runProcess("/usr/bin/true", [], QUICK);
  assert.equal(await readFile(victim, "utf8"), "user content\n");

  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "useful-skills-process-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE = path.join(elsewhere, "process-groups");
  await runProcess("/usr/bin/true", [], QUICK);
  assert.equal(existsSync(path.join(elsewhere, "process-groups")), false);

  const shared = await mkdtemp(path.join(realpathSync(os.tmpdir()), "useful-skills-run-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  await chmod(shared, 0o755);
  process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE = path.join(shared, "process-groups");
  await runProcess("/usr/bin/true", [], QUICK);
  assert.equal(existsSync(path.join(shared, "process-groups")), false);

  const linked = path.join(realpathSync(os.tmpdir()), `useful-skills-run-link-${process.pid}`);
  await symlink(directory, linked);
  t.after(() => rm(linked, { force: true }));
  process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE = path.join(linked, "process-groups-linked");
  await runProcess("/usr/bin/true", [], QUICK);
  assert.equal(existsSync(path.join(directory, "process-groups-linked")), false);
});

test("a process group record keeps only well-formed entries and never names this process or its own group", async (t) => {
  const { record } = await runRecord(t);
  const ownGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }));
  await writeFile(record, [
    "+42", "+43", "-43", `+${process.pid}`, `+${ownGroup}`, "+1", "+0", "+-7", "+0x10", "+1e3", "+ 44", "+45junk", "45", "",
  ].join("\n"));

  assert.deepEqual(recordedProcessGroups(record), new Set([42]));
});

test("a process group record that is not a small regular file reads as unknown without blocking", async (t) => {
  const { directory, record } = await runRecord(t);
  await writeFile(record, "+42\n".repeat(20_000));
  assert.equal(recordedProcessGroups(record), undefined);

  const fifo = path.join(directory, "fifo");
  execFileSync("mkfifo", [fifo]);
  const processModule = pathToFileURL(path.resolve(import.meta.dirname, "../process.js")).href;
  const reader = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `import { recordedProcessGroups } from ${JSON.stringify(processModule)};`,
    `process.stdout.write(String(recordedProcessGroups(${JSON.stringify(fifo)})));`,
  ].join("\n")], { encoding: "utf8", timeout: 3_000 });

  assert.equal(reader.signal, null);
  assert.equal(reader.stdout, "undefined");
});

test("a process group record reads as unknown unless this user alone can enter its directory", async (t) => {
  const { directory, record } = await runRecord(t);
  await writeFile(record, "+42\n");
  assert.deepEqual(recordedProcessGroups(record), new Set([42]));

  await chmod(directory, 0o755);
  assert.equal(recordedProcessGroups(record), undefined);
});

test("a record that the OpenCode runner removed is never read again, even when recreated at once", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "entry.mjs");
  await writeFile(entry, "process.stdout.write(process.env.USEFUL_SKILLS_PROCESS_GROUPS_FILE);");

  // Another user of a shared temporary directory may recreate it as soon as it is removed, naming any group.
  for (const mode of [0o755, 0o700]) {
    const victim = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
    t.after(() => victim.kill("SIGKILL"));

    const { stdout: record } = await runNode(entry);
    mkdirSync(path.dirname(record), { mode });
    t.after(() => rm(path.dirname(record), { recursive: true, force: true }));
    writeFileSync(record, `+${victim.pid}\n`);

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.doesNotThrow(() => process.kill(victim.pid, 0), `the victim in a recreated ${mode.toString(8)} directory was signalled`);
  }
});
