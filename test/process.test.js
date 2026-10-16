import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { minimalEnvironment, runProcess } from "../process.js";

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
