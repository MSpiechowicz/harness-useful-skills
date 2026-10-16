import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowContext } from "../opencode/context.js";
import { NodeUnavailable, runNode } from "../opencode/node-runner.js";
import { createSession } from "../opencode/session.js";
import { effectiveWorkflow } from "../workflow-policy.js";

const SECRET = "pass" + "word=" + "synthetic-example-value-12345";
const DIRECTORY = "/work/project";
const RUNTIME = "/runtime/useful-skills";
const UNKNOWN_CONTEXT = workflowContext(effectiveWorkflow(undefined));

function hookResult(text) {
  return { exitCode: 0, stdout: `${JSON.stringify({ text })}\n`, stderr: "" };
}

/** A runner stub that records each subprocess request and answers with `respond(name, args, options)`. */
function stubRunner(respond = (name, args) => hookResult(`${name} ${args.join(" ")}`)) {
  const calls = [];
  const run = async (script, args, options) => {
    calls.push({ script, args, options });
    return respond(path.basename(script), args, options);
  };
  return { run, calls };
}

function harness({ respond, maxSessions, sessionParent } = {}) {
  const runner = stubRunner(respond);
  const toasts = [];
  const session = createSession({
    directory: DIRECTORY,
    runtimeRoot: RUNTIME,
    run: runner.run,
    toast: text => toasts.push(text),
    sessionParent,
    maxSessions,
  });
  return { session, calls: runner.calls, toasts };
}

/** A runner answer that numbers each context so tests can tell which prompt produced the cached one. */
function numberedContexts() {
  let count = 0;
  return (name, args) => hookResult(args[0] === "context" ? `context ${++count} ${args.slice(1).join(" ")}`.trim() : "note");
}

function injected(session, sessionID) {
  const system = ["host prompt"];
  session.systemTransform(sessionID, system);
  return system.slice(1);
}

test("system prompts get no context before a session's first chat message, then the cached context and routing note", async () => {
  const { session, calls } = harness();

  assert.deepEqual(injected(session, "s1"), []);
  await session.start({ checkForUpdate: false });
  assert.deepEqual(injected(session, "s1"), []);

  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context", "hook-cli.js sync-agents"]);
  assert.deepEqual(injected(session, "s2"), []);
  assert.deepEqual(injected(session, undefined), []);

  const contextCall = calls.find(call => call.args[0] === "context");
  assert.equal(contextCall.script, path.join(RUNTIME, "opencode", "hook-cli.js"));
  assert.equal(contextCall.options.cwd, DIRECTORY);
  assert.ok(contextCall.options.timeoutMs <= 10_000);
});

test("a user-run /us-ignore-workflow opts out exactly its own prompt and leaves its parts unchanged", async () => {
  const { session, calls } = harness();
  const parts = [{ type: "text", text: "fix the typo" }];
  const original = structuredClone(parts);

  await session.onCommand("us-ignore-workflow", "s1", "fix the typo", parts);
  assert.deepEqual(parts, original);

  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context --opt-out"]);

  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context"]);
  assert.deepEqual(calls.map(call => call.args), [["context", "--opt-out"], ["context"]]);
});

test("the prompt of a /useful-skills command keeps the cached context and runs no context subprocess", async () => {
  const { session, calls } = harness({ respond: numberedContexts() });

  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["context 1"]);

  await session.onCommand("useful-skills", "s1", "status", []);
  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["context 1"]);
  assert.equal(calls.filter(call => call.args[0] === "context").length, 1);

  await session.onChatMessage("s1");
  assert.deepEqual(injected(session, "s1"), ["context 2"]);
});

test("a /useful-skills prompt does not consume a pending opt-out, in either command order", async () => {
  const commandFirst = harness({ respond: numberedContexts() });
  await commandFirst.session.onCommand("us-ignore-workflow", "s1", "", []);
  await commandFirst.session.onChatMessage("s1");
  await commandFirst.session.onCommand("useful-skills", "s1", "status", []);
  await commandFirst.session.onChatMessage("s1");
  assert.deepEqual(injected(commandFirst.session, "s1"), ["context 1 --opt-out"]);
  await commandFirst.session.onChatMessage("s1");
  assert.deepEqual(injected(commandFirst.session, "s1"), ["context 2"]);

  const pendingFirst = harness({ respond: numberedContexts() });
  await pendingFirst.session.onCommand("us-ignore-workflow", "s1", "", []);
  await pendingFirst.session.onCommand("useful-skills", "s1", "status", []);
  await pendingFirst.session.onChatMessage("s1");
  assert.deepEqual(injected(pendingFirst.session, "s1"), []);
  await pendingFirst.session.onChatMessage("s1");
  assert.deepEqual(injected(pendingFirst.session, "s1"), ["context 1 --opt-out"]);
  await pendingFirst.session.onChatMessage("s1");
  assert.deepEqual(injected(pendingFirst.session, "s1"), ["context 2"]);
});

test("child sessions get no context and deleted sessions are forgotten", async () => {
  const { session, calls } = harness();

  session.onEvent({ type: "session.created", properties: { info: { id: "child", parentID: "parent" } } });
  await session.onChatMessage("child");
  assert.deepEqual(calls, []);
  assert.deepEqual(injected(session, "child"), []);

  session.onEvent({ type: "session.created", properties: { info: { id: "parent" } } });
  await session.onChatMessage("parent");
  assert.deepEqual(injected(session, "parent"), ["hook-cli.js context"]);

  session.onEvent({ type: "session.deleted", properties: { info: { id: "parent" } } });
  assert.deepEqual(injected(session, "parent"), []);

  session.onEvent(undefined);
  session.onEvent({ type: "session.created" });
});

test("sessions without a creation event are classified once by asking the host for their parent", async () => {
  const lookups = [];
  const parents = { child: "main", main: undefined };
  const { session, calls } = harness({
    sessionParent: async id => {
      lookups.push(id);
      if (id === "flaky") {
        throw new Error("server busy");
      }
      return parents[id];
    },
  });

  await session.onChatMessage("child");
  await session.onChatMessage("child");
  assert.deepEqual(injected(session, "child"), []);

  await session.onChatMessage("main");
  await session.onChatMessage("main");
  assert.deepEqual(injected(session, "main"), ["hook-cli.js context"]);

  session.onEvent({ type: "session.created", properties: { info: { id: "known", parentID: "main" } } });
  await session.onChatMessage("known");
  assert.deepEqual(injected(session, "known"), []);

  await session.onChatMessage("flaky");
  await session.onChatMessage("flaky");
  assert.deepEqual(injected(session, "flaky"), ["hook-cli.js context"]);

  assert.deepEqual(lookups, ["child", "main", "flaky", "flaky"]);
  assert.equal(calls.length, 4);
});

test("a context subprocess without Node.js tells the user once and other failures stay silent", async () => {
  const missing = harness({ respond: () => { throw new NodeUnavailable(); } });
  await missing.session.onChatMessage("s1");
  await missing.session.onChatMessage("s1");
  await missing.session.onChatMessage("s2");
  assert.deepEqual(missing.toasts, ["Useful Skills needs Node.js 22+ on PATH; workflow guidance is limited until then."]);

  const timedOut = harness({ respond: () => { throw new Error("timed out"); } });
  await timedOut.session.onChatMessage("s1");
  assert.deepEqual(timedOut.toasts, []);
});

test("a failed context subprocess caches the unknown-settings context", async () => {
  const failures = [
    () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    () => hookResult(42),
    () => { throw new NodeUnavailable(); },
    () => { throw new Error("timed out"); },
  ];

  for (const respond of failures) {
    const { session } = harness({ respond });
    await session.onChatMessage("s1");
    assert.deepEqual(injected(session, "s1"), [UNKNOWN_CONTEXT]);
  }
  assert.match(UNKNOWN_CONTEXT, /invalid or unreadable/);
});

test("/useful-skills replaces the prompt parts in place with one verbatim result part", async () => {
  const { session, calls } = harness({
    respond: () => ({ exitCode: 2, stdout: `Usage: workflow enabled|disabled\n${SECRET}\n`, stderr: "" }),
  });
  const parts = [{ type: "text", text: "template" }, { type: "file", url: "x" }];
  const array = parts;

  await session.onCommand("useful-skills", "s1", "  workflow  maybe ", parts);

  assert.equal(parts, array);
  assert.equal(parts.length, 1);
  assert.deepEqual(Object.keys(parts[0]).sort(), ["text", "type"]);
  assert.equal(parts[0].type, "text");
  assert.equal(parts[0].text, [
    "Useful Skills `/useful-skills` result (exit 2). Show it to the user verbatim; take no other action:",
    "",
    "Usage: workflow enabled|disabled",
    "password=[REDACTED]",
  ].join("\n"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, path.join(RUNTIME, "opencode", "command.js"));
  assert.deepEqual(calls[0].args, ["workflow  maybe"]);
  assert.deepEqual(calls[0].options, { cwd: DIRECTORY, timeoutMs: 60_000 });
});

test("bare /useful-skills passes no arguments and shows stderr when stdout is empty", async () => {
  const { session, calls, toasts } = harness({ respond: () => ({ exitCode: 0, stdout: "", stderr: "help on stderr\n" }) });

  const parts = [];
  await session.onCommand("useful-skills", "s1", "", parts);
  assert.deepEqual(calls[0].args, []);
  assert.match(parts[0].text, /\(exit 0\)[^]*\n\nhelp on stderr$/);
  assert.deepEqual(toasts, []);
});

test("/useful-skills reports a run with no output as (no output)", async () => {
  const { session } = harness({ respond: () => ({ exitCode: 0, stdout: " \n", stderr: "" }) });
  const parts = [];

  await session.onCommand("useful-skills", "s1", "status", parts);
  assert.match(parts[0].text, /\(exit 0\)[^]*\n\n\(no output\)$/);
});

test("doctor, graph test, and update install get a long timeout and a notice; other commands do not", async () => {
  const { session, calls, toasts } = harness({ respond: () => ({ exitCode: 0, stdout: "done\n", stderr: "" }) });
  const budgets = [
    [" doctor ", 600_000, "Useful Skills: running doctor; first setup can take minutes."],
    ["graph   test", 600_000, "Useful Skills: running the graph test; it can take minutes."],
    ["update install", 600_000, "Useful Skills: installing the update; it can take minutes."],
    ["doctor --check", 60_000],
    ["update check", 60_000],
    ["graph", 60_000],
    ["status", 60_000],
  ];

  for (const [argument, timeoutMs, notice] of budgets) {
    toasts.length = 0;
    await session.onCommand("useful-skills", "s1", argument, []);
    assert.equal(calls.at(-1).options.timeoutMs, timeoutMs, argument);
    assert.deepEqual(toasts, notice ? [notice] : [], argument);
  }
});

test("/useful-skills without Node.js or with a failed subprocess reports that nothing ran", async () => {
  const missing = harness({ respond: () => { throw new NodeUnavailable(); } });
  const parts = [{ type: "text", text: "template" }];
  await missing.session.onCommand("useful-skills", "s1", "status", parts);
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /^Useful Skills `\/useful-skills` did not run\./);
  assert.match(parts[0].text, /Node\.js 22 or newer must be on PATH/);

  const failed = harness({ respond: () => { throw new Error(`stopped ${SECRET}`); } });
  const failedParts = [];
  await failed.session.onCommand("useful-skills", "s1", "status", failedParts);
  assert.match(failedParts[0].text, /did not run[^]*stopped password=\[REDACTED\]$/);
});

test("other commands and malformed command input leave parts alone", async () => {
  const { session, calls } = harness();
  const parts = [{ type: "text", text: "keep" }];

  await session.onCommand("review", "s1", "", parts);
  await session.onCommand("useful-skills", "s1", "status", undefined);
  assert.deepEqual(parts, [{ type: "text", text: "keep" }]);
  assert.deepEqual(calls, []);
});

test("the bash guard denies dangerous and malformed commands and lets other tools pass", () => {
  const { session } = harness();

  assert.throws(() => session.beforeTool("bash", { command: `rm -rf / && echo ${SECRET}` }), error => (
    /Useful Skills safety guard/.test(error.message) && !error.message.includes("synthetic-example-value-12345")
  ));
  assert.throws(() => session.beforeTool("bash", {}), { message: "Useful Skills hook received invalid event input." });
  assert.throws(() => session.beforeTool("bash", undefined), { message: "Useful Skills hook received invalid event input." });
  assert.throws(() => session.beforeTool("bash", { command: 42 }), { message: "Useful Skills hook received invalid event input." });

  assert.equal(session.beforeTool("bash", { command: "rm -rf build/" }), undefined);
  assert.equal(session.beforeTool("edit", { command: "rm -rf /" }), undefined);
});

test("bash results are redacted in title, output, and metadata output", () => {
  const { session } = harness();
  const attachments = [{ type: "file", url: `data:text/plain,${SECRET}` }];
  const output = {
    title: `cat ${SECRET}`,
    output: `line\n${SECRET}`,
    metadata: { output: SECRET, exit: 0, truncated: false, nested: [{ value: SECRET }] },
    attachments,
  };

  session.afterTool(output);

  assert.equal(output.title, "cat password=[REDACTED]");
  assert.equal(output.output, "line\npassword=[REDACTED]");
  assert.deepEqual(output.metadata, {
    output: "password=[REDACTED]", exit: 0, truncated: false, nested: [{ value: "password=[REDACTED]" }],
  });
  assert.equal(output.attachments, attachments);
});

test("MCP results are redacted in content text and structuredContent while image data stays intact", () => {
  const { session } = harness();
  const image = { type: "image", data: "cGFzc3dvcmQ9c2VjcmV0", mimeType: "image/png" };
  const meta = { note: SECRET };
  const output = {
    content: [{ type: "text", text: SECRET }, image],
    structuredContent: { results: [{ snippet: SECRET }] },
    _meta: meta,
  };

  session.afterTool(output);

  assert.deepEqual(output.content[0], { type: "text", text: "password=[REDACTED]" });
  assert.equal(output.content[1], image);
  assert.deepEqual(output.structuredContent, { results: [{ snippet: "password=[REDACTED]" }] });
  assert.equal(output._meta, meta);
});

test("unchanged tool results keep their field identity and missing results are ignored", () => {
  const { session } = harness();
  const metadata = { output: "safe", exit: 0 };
  const output = { title: "ls", output: "safe", metadata };

  session.afterTool(output);
  assert.equal(output.metadata, metadata);
  assert.deepEqual(Object.keys(output), ["title", "output", "metadata"]);

  session.afterTool(undefined);
  session.afterTool("text");
});

test("session state is bounded to the most recently used sessions", async () => {
  const { session } = harness({ maxSessions: 2 });

  await session.onChatMessage("s1");
  await session.onChatMessage("s2");
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context"]);
  await session.onChatMessage("s3");

  assert.deepEqual(injected(session, "s2"), []);
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context"]);
  assert.deepEqual(injected(session, "s3"), ["hook-cli.js context"]);

  await session.onChatMessage("s1");
  await session.onChatMessage("s4");
  assert.deepEqual(injected(session, "s3"), []);
  assert.deepEqual(injected(session, "s1"), ["hook-cli.js context"]);
});

test("start runs agent sync and one optional quiet update check, toasting only a non-empty notice", async () => {
  const quiet = harness({ respond: (name, args) => hookResult(args[0] === "update-check" ? "  " : "note") });
  await quiet.session.start();
  assert.deepEqual(quiet.calls.map(call => call.args), [["sync-agents"], ["update-check"]]);
  assert.deepEqual(quiet.toasts, []);

  const newer = harness({ respond: (name, args) => hookResult(args[0] === "update-check" ? "Update 9.9.9 available\n" : "note") });
  await newer.session.start();
  assert.deepEqual(newer.toasts, ["Update 9.9.9 available"]);

  const skipped = harness();
  await skipped.session.start({ checkForUpdate: false });
  assert.deepEqual(skipped.calls.map(call => call.args), [["sync-agents"]]);
});

test("start failures and a failing toast stay silent", async () => {
  const failed = harness({ respond: () => { throw new NodeUnavailable(); } });
  await failed.session.start();
  assert.deepEqual(failed.toasts, []);

  for (const toast of [() => { throw new Error("no tui"); }, () => Promise.reject(new Error("no tui"))]) {
    const session = createSession({
      directory: DIRECTORY,
      runtimeRoot: RUNTIME,
      run: async () => hookResult("Update available"),
      toast,
    });
    await session.start();
  }
});

/** Resolve once `pid` no longer exists, failing after a few seconds. */
async function processGone(pid) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function runnerFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "script.mjs");
  await writeFile(script, RUNNER_SCRIPT);
  return { directory, script };
}

// `spawn <pidFile> <stdio> <then>` starts a long-lived grandchild, records its pid, then hangs or exits.
const RUNNER_SCRIPT = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const [mode, value, stdio, then] = process.argv.slice(2);",
  "if (mode === 'echo') { process.stdout.write(`${process.cwd()} ${value}`); process.stderr.write('warn'); }",
  "if (mode === 'exit') process.exit(Number(value));",
  "if (mode === 'big') process.stdout.write('x'.repeat(Number(value)));",
  "if (mode === 'hang') setTimeout(() => {}, 60_000);",
  "if (mode === 'spawn') {",
  "  const grandchild = spawn('node', ['-e', 'setTimeout(() => {}, 60_000)'], { stdio });",
  "  writeFileSync(value, String(grandchild.pid));",
  "  if (then === 'hang') setTimeout(() => {}, 60_000); else process.exit(0);",
  "}",
].join("\n");

test("runNode runs a script with Node.js from PATH and reports exit codes, timeouts, and oversized output", async t => {
  const { directory, script } = await runnerFixture(t);

  assert.deepEqual(await runNode(script, ["echo", "a b; $(x)"], { cwd: directory }), {
    exitCode: 0, stdout: `${directory} a b; $(x)`, stderr: "warn",
  });
  assert.equal((await runNode(script, ["exit", "3"])).exitCode, 3);
  await assert.rejects(runNode(script, ["big", "2048"], { maxBytes: 1024 }), /size limit/);
  await assert.rejects(runNode(script, ["hang"], { timeoutMs: 200 }), /did not finish within/);
  await assert.rejects(runNode(script, [], { cwd: path.join(directory, "missing") }), error => (
    !(error instanceof NodeUnavailable) && /working directory/.test(error.message)
  ));
  await assert.rejects(runNode(script, [], { env: { PATH: path.join(directory, "no-node") } }), NodeUnavailable);
});

test("runNode ends grandchildren when the subprocess times out or exits", async t => {
  const { directory, script } = await runnerFixture(t);
  const pidFile = path.join(directory, "grandchild.pid");

  // The grandchild holds the output pipes, so the subprocess result waits on it unless the group is ended.
  const started = Date.now();
  await assert.rejects(runNode(script, ["spawn", pidFile, "inherit", "hang"], { timeoutMs: 500 }), /did not finish/);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(await processGone(Number(await readFile(pidFile, "utf8"))), true);

  const result = await runNode(script, ["spawn", pidFile, "ignore", "exit"], { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(await processGone(Number(await readFile(pidFile, "utf8"))), true);
});
