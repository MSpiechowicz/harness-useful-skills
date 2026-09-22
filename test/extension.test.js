import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  const selectResponses = [];
  const selections = [];
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
    ui: {
      notify: (message, level) => messages.push({ message, level }),
      select: async (title, choices) => {
        selections.push({ title, choices });
        return selectResponses.shift();
      },
    },
    setTimeout: callback => timers.push(callback),
  };
  return { root, commands, events, tools, messages, timers, selectResponses, selections, ctx };
}

test("install reports progress before completion without duplicating a busy operation", async t => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "us-update-bin-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  });
  await writeFile(path.join(bin, "omp"), `#!${process.execPath}
if (process.argv.slice(-3).join(" ") !== "plugin list --json") process.exit(1);
console.log(JSON.stringify({ marketplace: [] }));
`, { mode: 0o755 });
  process.env.PATH = bin;
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));

  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      const f = await fixture(t, hasUI);
      const handler = f.commands.get("useful-skills").handler;
      const install = handler("update install", f.ctx);
      try {
        assert.equal(f.messages.length, 1, "progress must be visible while install is pending");
        assert.match(f.messages[0].message, /updating.*useful skills/i);
        if (hasUI) assert.equal(f.messages[0].level, "info");
        else assert.deepEqual(f.messages[0].options, { triggerTurn: false });
        await handler("update install", f.ctx);
        assert.equal(f.messages.length, 2, "busy request must not emit another progress notice");
        assert.match(f.messages[1].message, /already running/i);
      } finally {
        await install;
      }
      assert.match(f.messages.at(-1).message, /update failed.*source checkouts are never overwritten/i);

      f.messages.length = 0;
      const retry = handler("update install", f.ctx);
      assert.match(f.messages[0]?.message ?? "", /updating.*useful skills/i);
      await retry;

      f.messages.length = 0;
      const check = handler("update check", f.ctx);
      assert.deepEqual(f.messages, [], "check must not announce an installation");
      await check;
      assert.doesNotMatch(f.messages.at(-1).message, /updating/i);
      if (hasUI) {
        f.messages.length = 0;
        f.selectResponses.push("Update", "Install");
        await handler("", f.ctx);
        assert.deepEqual(f.selections.slice(-2), [
          { title: "Useful Skills", choices: ["List", "Libraries", "Doctor", "Update", "Help"] },
          { title: "Update", choices: ["Check", "Install"] },
        ]);
        assert.match(f.messages[0].message, /updating.*useful skills/i);
        f.messages.length = 0;
        f.selectResponses.push("Update", "Check");
        await handler("", f.ctx);
        assert.doesNotMatch(f.messages.at(-1).message, /updating/i);
      }
      f.messages.length = 0;
      await f.events.get("session_start")({}, f.ctx);
      if (hasUI) await f.timers[0]();
      assert.deepEqual(f.messages, [], "startup without an available update must remain quiet");
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});
test("session prompts receive independent, idempotent workflow guidance without workflow or memory side effects", async t => {
  const f = await fixture(t);
  let nativeCalls = 0;
  f.ctx.memory = { status: async () => { nativeCalls++; return {}; } };
  const hook = f.events.get("before_agent_start");
  const basePrompt = Object.freeze(["preserve this instruction"]);
  const first = hook({ systemPrompt: basePrompt, prompt: "build a simulator" }, f.ctx);

  assert.deepEqual(basePrompt, ["preserve this instruction"], "the incoming prompt must not be mutated");
  assert.notEqual(first.systemPrompt, basePrompt);
  assert.deepEqual(first.systemPrompt.slice(0, 1), basePrompt, "existing instructions must be preserved");
  assert.equal(first.systemPrompt.length, 3);
  const [discovery, policy] = first.systemPrompt.slice(1);

  const discoveryOnly = hook({ systemPrompt: ["base", discovery] }, f.ctx);
  assert.deepEqual(discoveryOnly.systemPrompt, ["base", discovery, policy]);
  const policyOnly = hook({ systemPrompt: ["base", policy] }, f.ctx);
  assert.deepEqual(policyOnly.systemPrompt, ["base", policy, discovery]);
  assert.equal(hook({ systemPrompt: first.systemPrompt }, f.ctx), undefined, "repeating a prompt must not add guidance again");

  const otherSession = hook({ systemPrompt: ["other workspace"] }, { ...f.ctx, cwd: path.join(f.root, "other") });
  assert.deepEqual(otherSession.systemPrompt, ["other workspace", discovery, policy], "guidance must not retain session or workspace state");
  await f.events.get("session_start")({}, f.ctx);
  await f.events.get("session_start")({}, f.ctx);
  assert.equal(f.timers.length, 1, "only the existing quiet update check is scheduled");
  assert.deepEqual([...f.events.keys()], ["before_agent_start", "tool_call", "tool_result", "session_start"]);
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
  assert.deepEqual(await readdir(f.root), []);
});

test("doctor formats fresh, disabled, and failed memory states for consumers", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;

  await handler("doctor", f.ctx);
  assert.match(f.messages.at(-1).message, /Native: Unavailable/);
  assert.match(f.messages.at(-1).message, /Graph: Not built/);
  assert.doesNotMatch(f.messages.at(-1).message, /"native"|\/profile\//);

  f.ctx.memory = { status: async () => ({ backend: "off", active: false }) };
  await handler("doctor", f.ctx);
  assert.match(f.messages.at(-1).message, /Native: Disabled/);

  f.ctx.memory = { status: async () => { throw new Error("profile unavailable"); } };
  await handler("doctor", f.ctx);
  assert.match(f.messages.at(-1).message, /Native: Error — Native memory status failed: profile unavailable/);
});
test("headless help does not start another model turn; menu cancellation is inert", async t => {
  const f = await fixture(t, false);
  await f.commands.get("useful-skills").handler("", f.ctx);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  const count = f.messages.length;
  await f.commands.get("useful-skills").handler("", { ...f.ctx, hasUI: true });
  assert.equal(f.messages.length, count);
  f.selectResponses.push("Update");
  await f.commands.get("useful-skills").handler("", { ...f.ctx, hasUI: true });
  assert.equal(f.messages.length, count);
  assert.deepEqual(f.selections.slice(-2), [
    { title: "Useful Skills", choices: ["List", "Libraries", "Doctor", "Update", "Help"] },
    { title: "Update", choices: ["Check", "Install"] },
  ]);
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
