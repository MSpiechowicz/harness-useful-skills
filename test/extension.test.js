import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
        assert.ok(f.selections.at(-1).choices.includes("Install"));
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

test("catalog accepts whitespace queries and no obsolete aliases", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await handler("  list   us-run-workflow  ", f.ctx);
  assert.match(f.messages.at(-1).message, /\/skill:us-run-workflow/);
  await handler("list us-ignore-workflow", f.ctx);
  assert.match(f.messages.at(-1).message, /\/skill:us-ignore-workflow/);
  await handler("library\tlist skills tdd-workflow", f.ctx);
  assert.match(f.messages.at(-1).message, /Expected list/);
  await handler("memory save nope", f.ctx);
  assert.match(f.messages.at(-1).message, /Expected list/);
  assert.deepEqual(await readdir(f.root), []);
});

test("doctor formats fresh, disabled, and failed memory states for consumers", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;

  await handler("doctor", f.ctx);
  assert.match(f.messages.at(-1).message, /Native: Unavailable/);
  assert.doesNotMatch(f.messages.at(-1).message, /Graph:/);
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

test("every session start gives OMP's task tool the bundled agents, even without a UI", async t => {
  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      const f = await fixture(t, hasUI);
      await f.events.get("session_start")({}, f.ctx);

      const agents = path.join(f.agentDir, "agents");
      assert.deepEqual((await readdir(agents)).sort(), ["backend.md", "frontend.md", "planner.md"]);
      assert.match(await readFile(path.join(agents, "planner.md"), "utf8"), /^---\n# Generated by Useful Skills /);
    });
  }
});

test("a session start that cannot write the agents still starts, and doctor reports agents and conflicts", async t => {
  const f = await fixture(t, false);
  const agents = path.join(f.agentDir, "agents");
  await mkdir(agents);
  await writeFile(path.join(agents, "frontend.md"), "---\nname: frontend\n---\nmine\n");
  f.ctx.memory = { status: async () => ({ backend: "off", active: false }) };

  await f.events.get("session_start")({}, f.ctx);
  await f.commands.get("useful-skills").handler("doctor", f.ctx);

  const report = f.messages.at(-1).message;
  assert.match(report, /OMP agents: backend, planner ready\n/);
  assert.match(report, /Conflict: frontend — /);
  assert.equal(await readFile(path.join(agents, "frontend.md"), "utf8"), "---\nname: frontend\n---\nmine\n");

  await rm(f.agentDir, { recursive: true });
  await writeFile(f.agentDir, "a file, not a directory");
  assert.equal(f.events.get("session_start")({}, f.ctx), undefined);
});

function hintFixture(t, { fail = false } = {}) {
  const calls = [];
  const services = {
    resolve: () => "/fake/harness-memory",
    execFile: (binary, args, options, done) => {
      calls.push(args);
      if (fail) {
        done(new Error("boom"));
      } else {
        done(null, JSON.stringify({ hint: `use code_symbol for ${args[args.indexOf("--query") + 1]}` }));
      }
    },
  };
  return { calls, services };
}

async function searchFixture(t, options) {
  const { calls, services } = hintFixture(t, options);
  const f = await fixture(t, true, undefined, undefined, { codeHintServices: services });
  return { f, calls };
}

const grepResult = (toolName, input, text = "src/a.js:1:match") => ({ toolName, input, isError: false, content: [{ type: "text", text }] });

test("an identifier grep result gets the code hint appended after the matches and redaction still applies", async t => {
  const { f, calls } = await searchFixture(t);
  const result = await f.events.get("tool_result")(grepResult("grep", { pattern: "alphaName" }, "token=" + "x".repeat(24)), f.ctx);
  assert.deepEqual(result.content.map(block => block.text), ["token=[REDACTED]", "use code_symbol for alphaName"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf("--project") + 1], f.root);
  const again = await f.events.get("tool_result")(grepResult("grep", { pattern: "alphaName" }), f.ctx);
  assert.equal(again, undefined, "the same term is hinted once per session");
  assert.match(calls[0].join(" "), /code hint/);
});

test("a bash rg or grep command for an identifier gets the hint too", async t => {
  const { f } = await searchFixture(t);
  const result = await f.events.get("tool_result")(grepResult("bash", { command: "rg -n betaName src" }), f.ctx);
  assert.deepEqual(result.content.map(block => block.text), ["src/a.js:1:match", "use code_symbol for betaName"]);
  assert.equal(await f.events.get("tool_result")(grepResult("bash", { command: "ls -la" }), f.ctx), undefined);
});

test("non-identifier patterns, other tools, errors, an off stage and a failing binary leave the result unchanged", async t => {
  const { f, calls } = await searchFixture(t);
  const run = event => f.events.get("tool_result")(event, f.ctx);
  assert.equal(await run(grepResult("grep", { pattern: "a|b" })), undefined);
  assert.equal(await run(grepResult("grep", { pattern: "two words" })), undefined);
  assert.equal(await run(grepResult("read", { pattern: "gammaName" })), undefined);
  assert.equal(await run({ ...grepResult("grep", { pattern: "gammaName" }), isError: true }), undefined);
  assert.equal(calls.length, 0);

  await f.commands.get("useful-skills").handler("stage code-graph disabled", f.ctx);
  assert.equal(await run(grepResult("grep", { pattern: "deltaName" })), undefined);
  assert.equal(calls.length, 0);

  const failing = await searchFixture(t, { fail: true });
  assert.equal(await failing.f.events.get("tool_result")(grepResult("grep", { pattern: "epsilonName" }), failing.f.ctx), undefined);
  assert.equal(failing.calls.length, 1);
});

test("several names in one grep pattern are tried in order until one has a hint", async t => {
  const calls = [];
  const services = {
    resolve: () => "/fake/harness-memory",
    execFile: (binary, args, options, done) => {
      const term = args[args.indexOf("--query") + 1];
      calls.push(term);
      done(null, JSON.stringify({ hint: term === "knownName" ? "use code_symbol for knownName" : null }));
    },
  };
  const f = await fixture(t, true, undefined, undefined, { codeHintServices: services });
  const result = await f.events.get("tool_result")(grepResult("grep", { pattern: "\\b(missOne|knownName|laterName)\\b" }), f.ctx);
  assert.deepEqual(result.content.map(block => block.text), ["src/a.js:1:match", "use code_symbol for knownName"]);
  assert.deepEqual(calls, ["missOne", "knownName"]);
});

function nudgeFixture(t, state = "indexed") {
  const calls = [];
  const services = {
    resolve: () => "/fake/harness-memory",
    execFile: (binary, args, options, done) => {
      calls.push({ args, options });
      if (state === "error") done(new Error("boom"));
      else done(null, JSON.stringify({ state }));
    },
  };
  return { calls, services };
}

async function nudgeSetup(t, state) {
  const { calls, services } = nudgeFixture(t, state);
  const f = await fixture(t, true, undefined, undefined, { codeHintServices: services });
  const run = event => f.events.get("tool_result")(event, f.ctx);
  return { f, calls, run };
}

const toolEvent = (toolName, input, text = "output") => ({ toolName, input, isError: false, content: [{ type: "text", text }] });
const INDEXED_TEXT = "This repository is in the code index. `code_map` shows its key files and signatures in one call, `code_symbol` where a name is defined and who uses it, `code_path` how one part reaches another. Use them before reading more files.";

test("an exploration command gets the indexed nudge once, asking the read-only repo command", async t => {
  const { f, calls, run } = await nudgeSetup(t);
  const result = await run(toolEvent("bash", { command: "find src -name '*.ts' | head" }));
  assert.deepEqual(result.content.map(block => block.text), ["output", INDEXED_TEXT]);
  assert.deepEqual(calls[0].args, ["code", "repo", "--project", f.root, "--json"]);
  assert.equal(calls[0].options.timeout, 1000);
  assert.equal(await run(toolEvent("bash", { command: "find src" })), undefined);
  assert.equal(calls.length, 1);
});

test("wc on a source folder and the third source read trigger the nudge, with the none text", async t => {
  const wc = await nudgeSetup(t, "none");
  const result = await wc.run(toolEvent("bash", { command: "wc -l src/**/*.ts" }));
  assert.match(result.content[1].text, /^This repository is not in the code index yet\. The first `code_map` call builds it/);
  assert.doesNotMatch(result.content[1].text, /;/);

  const reads = await nudgeSetup(t);
  const read = name => reads.run(toolEvent("read", { path: name }));
  assert.equal(await read("src/a.ts"), undefined);
  assert.equal(await read(path.join(reads.f.root, "src/b.rs")), undefined);
  assert.deepEqual((await read("src/c.svelte")).content.map(block => block.text), ["output", INDEXED_TEXT]);
  assert.equal(await read("src/d.ts"), undefined);
});

test("ls needs a recursive flag or a source folder, and a recursive ls is an exploration", async t => {
  const { run, calls } = await nudgeSetup(t);
  assert.equal(await run(toolEvent("bash", { command: "ls -la" })), undefined);
  assert.equal(calls.length, 0);
  assert.equal((await run(toolEvent("bash", { command: "ls -R" }))).content.length, 2);
});

test("no nudge after a code tool call, for other reads, outside the project, with the stage off or for other states", async t => {
  const used = await nudgeSetup(t);
  await used.f.events.get("tool_call")({ toolName: "read", input: { path: "xd://mcp__harness_memory_code_map" } }, used.f.ctx);
  assert.equal(await used.run(toolEvent("bash", { command: "find src" })), undefined);
  const viaResult = await nudgeSetup(t);
  await viaResult.run(toolEvent("write", { path: "xd://mcp__harness_memory_code_symbol" }));
  assert.equal(await viaResult.run(toolEvent("bash", { command: "find src" })), undefined);
  assert.equal(used.calls.length + viaResult.calls.length, 0);

  const other = await nudgeSetup(t);
  for (const name of ["README.md", "notes.txt", "package.json", "xd://skill/a.ts", "/elsewhere/a.ts", "../a.ts"]) {
    assert.equal(await other.run(toolEvent("read", { path: name })), undefined);
  }
  assert.equal(await other.run(toolEvent("read", { path: "src/a.ts" })), undefined);
  assert.equal(await other.run(toolEvent("bash", { command: "find /elsewhere" })), undefined);
  assert.equal(await other.run(toolEvent("bash", { command: "find src", cwd: "/elsewhere" })), undefined);
  assert.equal(other.calls.length, 0);

  const off = await nudgeSetup(t);
  await off.f.commands.get("useful-skills").handler("stage code-graph disabled", off.f.ctx);
  assert.equal(await off.run(toolEvent("bash", { command: "find src" })), undefined);
  assert.equal(off.calls.length, 0);

  for (const state of ["off", "refused", "tooLarge", "failed", "error"]) {
    const quiet = await nudgeSetup(t, state);
    assert.equal(await quiet.run(toolEvent("bash", { command: "find src" })), undefined, state);
    assert.equal(quiet.calls.length, 1);
  }
});

test("a nudge that could not be sent gives the claim back so a later trigger can try again", async t => {
  let state = "failed";
  const calls = [];
  const services = {
    resolve: () => "/fake/harness-memory",
    execFile: (binary, args, options, done) => { calls.push(args); done(null, JSON.stringify({ state })); },
  };
  const f = await fixture(t, true, undefined, undefined, { codeHintServices: services });
  const run = event => f.events.get("tool_result")(event, f.ctx);
  assert.equal(await run(toolEvent("bash", { command: "find src" })), undefined);
  state = "indexed";
  assert.equal((await run(toolEvent("bash", { command: "tree" }))).content[1].text, INDEXED_TEXT);
  assert.equal(await run(toolEvent("bash", { command: "find src" })), undefined);
  assert.equal(calls.length, 2);
});

test("two parallel exploration results carry one nudge", async t => {
  const { run, calls } = await nudgeSetup(t);
  const [first, second] = await Promise.all([run(toolEvent("bash", { command: "find src" })), run(toolEvent("bash", { command: "tree" }))]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(calls.length, 1);
});

test("a minted MCP code tool call stops the nudge", async t => {
  const { f, run } = await nudgeSetup(t);
  await f.events.get("tool_call")({ toolName: "mcp__harness_memory_code_map", input: {} }, f.ctx);
  assert.equal(await run(toolEvent("bash", { command: "find src" })), undefined);
});
