import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SECRET = "pass" + "word=" + "synthetic-example-value-12345";

// Without Node.js on PATH every subprocess fails, so these tests drive the V1 entry without running helpers.
const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-v1-"));
process.env.PATH = path.join(directory, "no-node");
test.after(() => rm(directory, { recursive: true, force: true }));

const entry = await import("../opencode/v1.js");

async function plugin(session) {
  const toasts = [];
  const client = { tui: { showToast: async request => { toasts.push(request); } }, session };
  const hooks = await entry.UsefulSkills({ directory, client, project: {}, worktree: directory });
  return { hooks, toasts };
}

async function injectedFor(hooks, sessionID) {
  const output = { system: ["host"] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output);
  return output.system.slice(1);
}

test("every export of the V1 entry is a plugin function", () => {
  const exports = Object.entries(entry);
  assert.deepEqual(exports.map(([name]) => name), ["UsefulSkills"]);
  for (const [name, value] of exports) {
    assert.equal(typeof value, "function", name);
  }
});

test("the V1 plugin returns the hooks it maps onto the session", async () => {
  const { hooks } = await plugin();
  assert.deepEqual(Object.keys(hooks).sort(), [
    "chat.message",
    "command.execute.before",
    "dispose",
    "event",
    "experimental.chat.system.transform",
    "tool.execute.after",
    "tool.execute.before",
  ]);
});

test("V1 chat and system hooks inject context only after a main session's chat message", async () => {
  const { hooks } = await plugin();
  const transform = async sessionID => {
    const output = { system: ["host"] };
    await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output);
    return output.system.slice(1);
  };

  assert.deepEqual(await transform("main"), []);
  await hooks["chat.message"]({ sessionID: "main" }, { message: {}, parts: [] });
  const [context] = await transform("main");
  assert.match(context, /Useful Skills workflow setting is invalid or unreadable/);

  await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "main" } } } });
  await hooks["chat.message"]({ sessionID: "child" }, { message: {}, parts: [] });
  assert.deepEqual(await transform("child"), []);
  assert.deepEqual(await transform(undefined), []);
});

test("V1 asks the session API for the parent of an unknown session once, and never during initialization", async () => {
  const lookups = [];
  const sessions = {
    "resumed-child": { data: { id: "resumed-child", parentID: "main" } },
    "resumed-main": { data: { id: "resumed-main" } },
    missing: { error: { name: "NotFoundError" } },
  };
  const { hooks, toasts } = await plugin({
    get: async request => {
      lookups.push(request);
      return sessions[request.path.id];
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(lookups, []);

  await hooks["chat.message"]({ sessionID: "resumed-child" }, { message: {}, parts: [] });
  await hooks["chat.message"]({ sessionID: "resumed-child" }, { message: {}, parts: [] });
  assert.deepEqual(await injectedFor(hooks, "resumed-child"), []);
  assert.deepEqual(lookups, [{ path: { id: "resumed-child" } }]);

  await hooks["chat.message"]({ sessionID: "resumed-main" }, { message: {}, parts: [] });
  assert.equal((await injectedFor(hooks, "resumed-main")).length, 1);

  await hooks["chat.message"]({ sessionID: "missing" }, { message: {}, parts: [] });
  assert.equal((await injectedFor(hooks, "missing")).length, 1);

  assert.deepEqual(toasts, [{
    body: { message: "Useful Skills needs Node.js 22+ on PATH; workflow guidance is limited until then.", variant: "info" },
  }]);
});

test("V1 /useful-skills replaces the parts array in place and reports that Node.js is required", async () => {
  const { hooks, toasts } = await plugin();
  const output = { parts: [{ type: "text", text: "template" }] };
  const parts = output.parts;

  await hooks["command.execute.before"]({ command: "useful-skills", sessionID: "main", arguments: "doctor" }, output);

  assert.equal(output.parts, parts);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "text");
  assert.match(parts[0].text, /did not run[^]*Node\.js 22 or newer must be on PATH/);
  assert.deepEqual(toasts, [{ body: { message: "Useful Skills: running doctor; first setup can take minutes.", variant: "info" } }]);
});

test("V1 tool hooks guard bash commands and redact results in place", async () => {
  const { hooks } = await plugin();
  const input = { tool: "bash", sessionID: "main", callID: "call" };

  await assert.rejects(hooks["tool.execute.before"](input, { args: { command: "rm -rf /" } }), /Useful Skills safety guard/);
  await assert.rejects(hooks["tool.execute.before"](input, { args: {} }), /invalid event input/);
  await hooks["tool.execute.before"](input, { args: { command: "ls" } });

  const output = { title: "cat .env", output: SECRET, metadata: { output: SECRET, exit: 0 } };
  await hooks["tool.execute.after"]({ ...input, args: {} }, output);
  assert.deepEqual(output, {
    title: "cat .env",
    output: "password=[REDACTED]",
    metadata: { output: "password=[REDACTED]", exit: 0 },
  });
  await hooks["tool.execute.after"]({ ...input, args: {} }, undefined);
});

test("V1 hooks tolerate a missing client and malformed inputs", async () => {
  const hooks = await entry.UsefulSkills({ directory });
  const parts = [];

  await hooks.event(undefined);
  await hooks["chat.message"](undefined, undefined);
  await hooks["experimental.chat.system.transform"](undefined, undefined);
  await hooks["command.execute.before"]({ command: "useful-skills", sessionID: "s", arguments: "doctor" }, { parts });
  assert.equal(parts.length, 1);
});

test("V1 dispose stops this instance's helpers, so a later command does not start one", async () => {
  const { hooks } = await plugin();
  const other = await plugin();
  await hooks.dispose();

  const parts = [];
  await hooks["command.execute.before"]({ command: "useful-skills", sessionID: "s", arguments: "help" }, { parts });
  assert.match(parts[0].text, /did not run[\s\S]*The subprocess was stopped/);

  // Another instance in the same process keeps working; here it reaches the missing Node.js.
  const otherParts = [];
  await other.hooks["command.execute.before"]({ command: "useful-skills", sessionID: "s", arguments: "help" }, { parts: otherParts });
  assert.match(otherParts[0].text, /Node\.js 22 or newer must be on PATH/);
});
