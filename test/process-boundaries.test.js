import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { minimalEnvironment, runProcess } from "../process.js";

function options(extra = {}) {
  return {
    cwd: process.cwd(),
    env: minimalEnvironment({ home: os.tmpdir(), cache: os.tmpdir(), tmp: os.tmpdir() }),
    timeoutMs: 2_000,
    ...extra,
  };
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-process-boundary-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("process runner rejects malformed invocation options before launch", () => {
  assert.throws(() => runProcess("node", [], options()), /absolute path/i);
  assert.throws(() => runProcess(process.execPath, null, options()), /array of strings/i);
  assert.throws(() => runProcess(process.execPath, [null], options()), /array of strings/i);
  assert.throws(() => runProcess(process.execPath, [], undefined), /options/i);
  assert.throws(() => runProcess(process.execPath, [], options({ cwd: "relative" })), /absolute path/i);
  assert.throws(() => runProcess(process.execPath, [], options({ timeoutMs: 0 })), /positive safe integer/i);
  assert.throws(() => runProcess(process.execPath, [], options({ maxBytes: Number.MAX_SAFE_INTEGER + 1 })), /positive safe integer/i);
  assert.throws(() => runProcess(process.execPath, [], options({ env: null })), /env/i);
  assert.throws(() => runProcess(process.execPath, [], options({ inheritedFds: null })), /inheritedFds.*array/i);
  for (const descriptors of [[0, -1], [1.5], ["3"], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => runProcess(process.execPath, [], options({ inheritedFds: descriptors })), /inheritedFds.*nonnegative safe integer/i);
  }
});

test("minimal environments reject relative owned locations and search paths", () => {
  assert.throws(() => minimalEnvironment({ home: "relative", cache: "/cache", tmp: "/tmp" }), /home.*absolute path/i);
  assert.throws(() => minimalEnvironment({ home: "/home", cache: null, tmp: "/tmp" }), /cache.*absolute path/i);
  assert.throws(() => minimalEnvironment({ home: "/home", cache: "/cache", tmp: undefined }), /tmp.*absolute path/i);
  assert.throws(() => minimalEnvironment({ home: "/home", cache: "/cache", tmp: "/tmp", pathEntries: ["bin"] }), /pathEntries.*absolute path/i);
  assert.equal(minimalEnvironment({ home: "/home", cache: "/cache", tmp: "/tmp" }).PATH, "");
});

test("pre-aborted execution reports cancellation without attempting to spawn", async (t) => {
  const root = await temporaryDirectory(t);
  const reason = new Error("Request withdrawn before launch");
  await assert.rejects(runProcess(path.join(root, "nonexistent-executable"), [], options({
    signal: AbortSignal.abort(reason),
  })), (error) => {
    assert.match(error.message, /cancelled/i);
    assert.equal(error.cause, reason);
    return true;
  });
});

test("missing executable reports the operating system startup failure", async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(runProcess(path.join(root, "nonexistent-executable"), [], options()), (error) => {
    assert.match(error.message, /cannot start process/i);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
});

test("nonzero exits retain both diagnostic streams", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e",
    "process.stdout.write('partial result'); process.stderr.write('explanation'); process.exitCode = 7;",
  ], options()), (error) => {
    assert.match(error.message, /code 7/);
    assert.equal(error.stdout, "partial result");
    assert.equal(error.stderr, "explanation");
    return true;
  });
});

test("nonzero exit errors expose structured exit status", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(7)"], options()), (error) => {
    assert.equal(error.exitCode, 7);
    assert.equal(error.signal, null);
    return true;
  });

  if (process.platform !== "win32") {
    await assert.rejects(runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options()), (error) => {
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, "SIGTERM");
      return true;
    });
  }
});

test("signal exits are failures rather than successful empty results", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options()), /signal SIGTERM/);
});

test("literal arguments preserve Unicode, empty values, and shell metacharacters", async () => {
  const values = ["", "naïve 日本語", "$(exit 9); 'quoted' & *"];
  const result = await runProcess(process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...values], options());
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test("children receive only explicitly inherited descriptors", async (t) => {
  const root = await temporaryDirectory(t);
  const descriptorFile = path.join(root, "descriptor.txt");
  await writeFile(descriptorFile, "inherited descriptor");
  const handle = await open(descriptorFile, "r");
  t.after(() => handle.close().catch(() => {}));

  const inherited = runProcess(process.execPath, ["-e", "setTimeout(() => process.stdout.write(require('node:fs').readFileSync(3, 'utf8')), 25)"], options({
    inheritedFds: [handle.fd],
  }));
  await handle.close();
  assert.equal((await inherited).stdout, "inherited descriptor");

  const privateHandle = await open(descriptorFile, "r");
  t.after(() => privateHandle.close());
  const identity = await privateHandle.stat();
  const leakCheckSource = [
    "const fs = require('node:fs');",
    "const leaked = [3, Number(process.argv[1])].some((fd) => {",
    "  try {",
    "    const stat = fs.fstatSync(fd);",
    "    return `${stat.dev}:${stat.ino}` === process.argv[2];",
    "  } catch {",
    "    return false;",
    "  }",
    "});",
    "process.stdout.write(String(leaked));",
  ].join("\n");
  const withoutInheritance = await runProcess(process.execPath, ["-e",
    leakCheckSource,
    String(privateHandle.fd), `${identity.dev}:${identity.ino}`,
  ], options());
  assert.equal(withoutInheritance.stdout, "false");
});

test("each stream can reach its exact byte bound independently", async () => {
  const result = await runProcess(process.execPath, ["-e",
    "process.stdout.write('é'.repeat(4)); process.stderr.write('abcdefgh')",
  ], options({ maxBytes: 8 }));
  assert.deepEqual(result, { stdout: "éééé", stderr: "abcdefgh" });
});

test("stderr overflow is bounded even when stdout is small", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e",
    "process.stdout.write('ok'); process.stderr.write('x'.repeat(65))",
  ], options({ maxBytes: 64 })), /stderr output exceeded 64 bytes/i);
});

test("embedded NUL environment values fail safely as startup errors", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(0)"], options({
    env: { BROKEN_VALUE: "before\0after" },
  })), { code: "ERR_INVALID_ARG_VALUE" });
});

async function waitForReady(file) {
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }

      await delay(10);
    }
  }

  throw new Error("Child process did not announce readiness");
}

async function processRunning(pid) {
  try {
    const state = await readFile(`/proc/${pid}/stat`, "utf8");
    // A killed orphan may remain a zombie until the host reaps it.
    return !/\) [ZX] /.test(state);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function descendantScenario(t, cancel) {
  const root = await temporaryDirectory(t);
  const readyFile = path.join(root, "ready.json");
  const controller = new AbortController();
  const childSource = [
    "process.on('SIGTERM', () => {});",
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, parent: process.ppid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parentSource = [
    "process.on('SIGTERM', () => {});",
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const running = runProcess(process.execPath, ["-e", parentSource, readyFile], options({
    timeoutMs: 5_000,
    signal: controller.signal,
  }));
  // Attach immediately: a failing startup must not become an unhandled rejection.
  const outcome = running.then((result) => ({ result }), (error) => ({ error }));
  let descendant;
  t.after(async () => {
    controller.abort();
    await outcome;

    if (descendant && await processRunning(descendant.pid)) {
      try {
        process.kill(descendant.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  });

  descendant = await waitForReady(readyFile);
  assert.equal(await processRunning(descendant.pid), true);

  if (cancel) {
    controller.abort(new Error("cancel running process tree"));
  }

  const { error } = await outcome;
  assert.ok(error instanceof Error, "a stopped process must reject");
  assert.match(error.message, cancel ? /cancelled/i : /timed out/i);
  assert.equal(await processRunning(descendant.pid), false, "SIGTERM-resistant descendant must be stopped");
  assert.equal(await processRunning(descendant.parent), false, "SIGTERM-resistant parent must be stopped");
}

test("cancellation escalates to stop already-running resistant descendants", { skip: process.platform !== "linux" }, async (t) => {
  await descendantScenario(t, true);
});

test("timeout escalates to stop already-running resistant descendants", { skip: process.platform !== "linux" }, async (t) => {
  await descendantScenario(t, false);
});
