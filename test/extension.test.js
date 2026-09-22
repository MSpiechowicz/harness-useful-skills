import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import usefulSkills from "../extension.js";

async function fixture(t, hasUI = true) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "us-extension-"));
  const root = path.join(parent, "workspace");
  const agentDir = path.join(parent, "profile");
  await mkdir(root);
  await mkdir(agentDir);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const commands = new Map();
  const events = new Map();
  const tools = new Map();
  const messages = [];
  const timers = [];
  usefulSkills({
    setLabel() {},
    pi: { getAgentDir: () => agentDir },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: definition => tools.set(definition.name, definition),
    on: (name, callback) => events.set(name, callback),
    sendMessage: (message, options) => messages.push({ message: message.content, options }),
  });
  const ctx = {
    cwd: root, hasUI,
    ui: { notify: (message, level) => messages.push({ message, level }), select: async () => undefined },
    setTimeout: callback => timers.push(callback),
  };
  return { root, commands, events, tools, messages, timers, ctx };
}

test("startup and prompts only advertise skills, without memory or workflow side effects", async t => {
  const f = await fixture(t);
  let nativeCalls = 0;
  f.ctx.memory = { status: async () => { nativeCalls++; return {}; } };
  await f.events.get("session_start")({}, f.ctx);
  await f.events.get("session_start")({}, f.ctx);
  assert.equal(f.timers.length, 1);
  const hint = await f.events.get("before_agent_start")({ systemPrompt: ["base"], prompt: "build a simulator" }, f.ctx);
  assert.equal(hint.systemPrompt.length, 2);
  assert.ok(hint.systemPrompt[1].length < 300);
  assert.equal(await f.events.get("before_agent_start")({ systemPrompt: hint.systemPrompt }, f.ctx), undefined);
  await f.events.get("session_stop")?.({}, f.ctx);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual([...f.commands.keys()], ["useful-skills"]);
  assert.deepEqual([...f.tools.keys()], ["us_memory"]);
  assert.equal(f.tools.get("us_memory").loadMode, "essential");
});

test("the registered memory tool performs explicit native actions, not startup hooks", async t => {
  const f = await fixture(t);
  const facts = [];
  f.ctx.memory = {
    status: async () => ({ backend: "local", active: true, writable: true, searchable: true }),
    save: async input => { facts.push(input.content); return { backend: "local", stored: 1 }; },
  };
  const result = await f.tools.get("us_memory").execute("call", { action: "save", content: "Keep fixture dimensions in meters." }, undefined, undefined, f.ctx);
  assert.deepEqual(facts, ["Keep fixture dimensions in meters."]);
  assert.equal(result.details.ok, true);
  assert.equal(JSON.parse(result.content[0].text).ok, true);
  const invalid = await f.tools.get("us_memory").execute("bad", { action: "erase" }, undefined, undefined, f.ctx);
  assert.equal(invalid.isError, true);
});

test("registered memory saves remain searchable with nullable transport fields", async t => {
  const f = await fixture(t);
  const facts = [];
  f.ctx.memory = {
    save: async ({ content }) => { facts.push(content); return { backend: "local", stored: 1 }; },
    search: async query => {
      const items = facts.filter(content => content.includes(query)).map(content => ({ content }));
      return { backend: "local", count: items.length, items };
    },
  };
  const memory = f.tools.get("us_memory");
  const save = await memory.execute("save", { action: "save", query: null, content: "Keep fixture dimensions in meters." }, undefined, undefined, f.ctx);
  assert.equal(save.details.ok, true);
  const search = await memory.execute("search", { action: "search", query: "meters", content: null }, undefined, undefined, f.ctx);
  assert.equal(search.details.ok, true);
  assert.deepEqual(search.details.observation.items, [{ content: "Keep fixture dimensions in meters." }]);
  const rejected = await memory.execute("secret", { action: "save", query: null, content: "token=" + "x".repeat(24) }, undefined, undefined, f.ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.details.error, /secret-shaped/i);
  assert.deepEqual(facts, ["Keep fixture dimensions in meters."]);
});

test("memory approval tiers keep observation readable and mutations gated", async t => {
  const f = await fixture(t);
  const approval = f.tools.get("us_memory").approval;
  assert.equal(approval({ action: "status" }), "read");
  assert.equal(approval({ action: "search" }), "read");
  assert.equal(approval({ action: "save" }), "write");
  assert.equal(approval({ action: "build" }), "exec");
  assert.equal(approval({ action: "query" }), "exec");
  assert.equal(approval(undefined), "exec");
});

test("catalog accepts whitespace queries, reference URIs, and no obsolete aliases", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await handler("  list   us-workflow  ", f.ctx);
  assert.match(f.messages.at(-1).message, /\/skill:us-workflow/);
  await handler("library\tlist skills tdd-workflow", f.ctx);
  assert.match(f.messages.at(-1).message, /skill:\/\/us-library\/references\/ecc\/skills\/tdd-workflow\/SKILL.md/);
  assert.doesNotMatch(f.messages.at(-1).message, /\/skill:tdd-workflow/);
  await handler("memory save nope", f.ctx);
  assert.match(f.messages.at(-1).message, /Expected list/);
  await handler("doctor", f.ctx);
  assert.match(f.messages.at(-1).message, /no setup\/build/);
  assert.deepEqual(await readdir(f.root), []);
});

test("headless help does not start another model turn; menu cancellation is inert", async t => {
  const f = await fixture(t, false);
  await f.events.get("session_start")({}, f.ctx);
  assert.equal(f.timers.length, 0);
  await f.commands.get("useful-skills").handler("", f.ctx);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  const count = f.messages.length;
  await f.commands.get("useful-skills").handler("", { ...f.ctx, hasUI: true });
  assert.equal(f.messages.length, count);
  await f.commands.get("useful-skills").handler("help", f.ctx);
  assert.match(f.messages.at(-1).message, /\/skill:us-/);
});

test("catastrophic protection and redaction are independent of selected workflow", async t => {
  const f = await fixture(t);
  assert.equal(f.events.get("tool_call")({ toolName: "bash", input: { command: "rm -rf /" } }).block, true);
  assert.equal(f.events.get("tool_call")({ toolName: "bash", input: { command: "node --test" } }), undefined);
  assert.equal(f.events.get("tool_call")({ toolName: "read", input: { command: "rm -rf /" } }), undefined);
  const content = [{ type: "text", text: "token=" + "x".repeat(24) }];
  assert.equal(f.events.get("tool_result")({ content }).content[0].text, "token=[REDACTED]");
  assert.equal(f.events.get("tool_result")({ content: [{ type: "text", text: "safe" }] }), undefined);
});
