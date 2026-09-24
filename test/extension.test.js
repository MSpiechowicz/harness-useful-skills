import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/extension-fixture.js";

test("install reports progress before completion without duplicating a busy operation", async t => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "us-update-bin-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(bin, { recursive: true, force: true });
  });
  await writeFile(path.join(bin, "omp"), `#!${process.execPath}
if (process.argv.slice(-3).join(" ") !== "plugin list --json") {
  process.exit(1);
}
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
        if (hasUI) {
          assert.equal(f.messages[0].level, "info");
        } else {
          assert.deepEqual(f.messages[0].options, { triggerTurn: false });
        }
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
        assert.ok(f.selections.at(-2).choices.includes("Update"));
        assert.deepEqual(f.selections.at(-1), { title: "Update", choices: ["Check", "Install"] });
        assert.match(f.messages[0].message, /updating.*useful skills/i);
        f.messages.length = 0;
        f.selectResponses.push("Update", "Check");
        await handler("", f.ctx);
        assert.doesNotMatch(f.messages.at(-1).message, /updating/i);
      }
      f.messages.length = 0;
      await f.events.get("session_start")({}, f.ctx);
      if (hasUI) {
        await f.timers[0]();
      }
      assert.deepEqual(f.messages, [], "startup without an available update must remain quiet");
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});

test("the registered memory tool performs explicit native actions, not startup hooks", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await handler("workflow disabled", f.ctx);
  await handler("stage backend-memory disabled", f.ctx);
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
  await handler("list us-ignore-workflow", f.ctx);
  assert.match(f.messages.at(-1).message, /\/skill:us-ignore-workflow/);
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

test("catastrophic protection and redaction are independent of selected workflow", async t => {
  const f = await fixture(t);
  assert.equal(f.events.get("tool_call")({ toolName: "bash", input: { command: "rm -rf /" } }).block, true);
  assert.equal(f.events.get("tool_call")({ toolName: "bash", input: { command: "node --test" } }), undefined);
  assert.equal(f.events.get("tool_call")({ toolName: "read", input: { command: "rm -rf /" } }), undefined);
  const content = [{ type: "text", text: "token=" + "x".repeat(24) }];
  assert.equal(f.events.get("tool_result")({ content }).content[0].text, "token=[REDACTED]");
  await f.commands.get("useful-skills").handler("workflow disabled", f.ctx);
  assert.equal(f.events.get("tool_call")({ toolName: "bash", input: { command: "rm -rf /" } }).block, true);
  assert.equal(f.events.get("tool_result")({ content }).content[0].text, "token=[REDACTED]");
  assert.equal(f.events.get("tool_result")({ content: [{ type: "text", text: "safe" }] }), undefined);
});
