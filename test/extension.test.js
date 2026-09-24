import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import usefulSkills from "../extension.js";
import { STAGES, readWorkflowSettings } from "../workflow-settings.js";

async function fixture(t, hasUI = true, memoryAction, sharedAgentDir) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "us-extension-"));
  const root = path.join(parent, "workspace");
  const agentDir = sharedAgentDir ?? path.join(parent, "profile");
  await mkdir(root);
  if (!sharedAgentDir) await mkdir(agentDir);
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
  }, { memoryAction });
  let currentSession = "session-one";
  const ctx = {
    cwd: root, hasUI,
    sessionManager: { getSessionId: () => currentSession },
    ui: {
      notify: (message, level) => messages.push({ message, level }),
      select: async (title, choices) => {
        selections.push({ title, choices });
        return selectResponses.shift();
      },
    },
    setTimeout: callback => timers.push(callback),
  };
  return { root, agentDir, commands, events, tools, messages, timers, selectResponses, selections, ctx,
    switchSession: id => { currentSession = id; } };
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
      if (hasUI) await f.timers[0]();
      assert.deepEqual(f.messages, [], "startup without an available update must remain quiet");
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});
test("profile guidance refreshes across sessions and instances, reconciling only owned instructions", async t => {
  const f = await fixture(t);
  let nativeCalls = 0;
  f.ctx.memory = { status: async () => { nativeCalls++; return {}; } };
  const hook = f.events.get("before_agent_start");
  const handler = f.commands.get("useful-skills").handler;
  const external = "preserve this independent instruction";
  const request = async (systemPrompt, prompt = "build a simulator") =>
    (await hook({ systemPrompt, prompt }, f.ctx))?.systemPrompt ?? systemPrompt;
  const defaults = await request(Object.freeze([external]));
  assert.equal(defaults[0], external);
  for (const stage of STAGES) assert.ok(defaults.some(line => line.includes(`automatic ${stage} stage enabled`)));
  assert.equal(await hook({ systemPrompt: defaults, prompt: "build a simulator" }, f.ctx), undefined);

  await handler("stage plan disabled", f.ctx);
  await handler("stage security-review disabled", f.ctx);
  await handler("stage backend-memory disabled", f.ctx);
  const selective = await request(defaults, "Document /skill:us-ignore-workflow for users.");
  assert.equal(selective[0], external);
  for (const stage of ["plan", "security-review", "backend-memory"]) {
    assert.ok(selective.some(line => line.includes(`automatic ${stage} stage disabled`)));
    assert.ok(!selective.some(line => line.includes(`automatic ${stage} stage enabled`)));
  }
  for (const stage of ["research", "review", "graphify-memory"]) {
    assert.ok(selective.some(line => line.includes(`automatic ${stage} stage enabled`)));
  }
  assert.ok(selective.some(line => line.includes("implementation without separate package-mandatory plan approval")));
  assert.ok(selective.some(line => line.includes("independent authorization requirements remain in force")));
  assert.equal(await hook({ systemPrompt: selective, prompt: "build a simulator" }, f.ctx), undefined);

  await handler("workflow disabled", f.ctx);
  const disabled = await request(selective, "Fix the bug. /skill:us-ignore-workflow");
  assert.equal(disabled[0], external);
  assert.ok(disabled.some(line => line.includes("fast lane is active")));
  assert.ok(!disabled.some(line => line.includes("automatic plan stage")));
  assert.ok(!disabled.some(line => line.includes("permit that required stage")));
  assert.equal(await hook({ systemPrompt: disabled, prompt: "build a simulator" }, f.ctx), undefined);
  f.switchSession("another-session");
  f.ctx.cwd = path.join(f.root, "different-workspace");
  assert.deepEqual(await request(selective), disabled, "profile setting, not session or workspace, selects guidance");

  const restarted = await fixture(t, true, undefined, f.agentDir);
  const otherHook = restarted.events.get("before_agent_start");
  const otherHandler = restarted.commands.get("useful-skills").handler;
  assert.deepEqual((await otherHook({ systemPrompt: selective, prompt: "fix a bug" }, restarted.ctx)).systemPrompt, disabled);
  await otherHandler("workflow enabled", restarted.ctx);
  assert.deepEqual(await request(disabled), selective, "another extension instance must refresh the same profile");
  await otherHandler("stage plan enabled", restarted.ctx);
  const restored = await request(selective);
  assert.ok(restored.some(line => line.includes("automatic plan stage enabled")));
  assert.ok(!restored.some(line => line.includes("automatic plan stage disabled")));
  assert.equal(nativeCalls, 0, "guidance does not perform automatic memory actions");
  assert.deepEqual(await readdir(f.root), []);
});

test("workflow and six independent stage commands persist exact modes, expose status, and reject invalid inputs", async t => {
  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      const f = await fixture(t, hasUI);
      const handler = f.commands.get("useful-skills").handler;
      await handler("workflow disabled", f.ctx);
      await handler("status", f.ctx);
      assert.match(f.messages.at(-1).message, /Research: saved enabled, effective disabled \(workflow disabled\)/);
      assert.ok(f.messages.at(-1).message.includes(path.join(f.agentDir, "useful-skills", "workflow-settings")));
      for (const stage of STAGES) await handler(`stage ${stage} disabled`, f.ctx);
      const before = await readWorkflowSettings({ agentDir: f.agentDir });
      for (const key of ["workflow", ...STAGES]) assert.equal(before.values[key], false);
      for (const input of [
        "workflow", "workflow enabled extra", "workflow off", "workflow Disabled",
        "stage", "stage research", "stage research Disabled", "stage unlisted enabled", "stage review enabled extra",
      ]) {
        await handler(input, f.ctx);
        assert.match(f.messages.at(-1).message, /Expected \/useful-skills/);
        if (hasUI) assert.equal(f.messages.at(-1).level, "warning");
        else assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
      }
      const after = await readWorkflowSettings({ agentDir: f.agentDir });
      assert.deepEqual(after.values, before.values);
      await handler("status", f.ctx);
      const report = f.messages.at(-1).message;
      assert.match(report, /Workflow: saved disabled, effective disabled/);
      assert.match(report, /Security review: saved disabled, effective disabled/);
      assert.match(report, /Graphify memory: saved disabled, effective disabled/);
      await handler("workflow enabled", f.ctx);
      assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false, "master switch retains stage choices");
      if (!hasUI) assert.ok(f.messages.every(message => message.options?.triggerTurn === false));
    });
  }
});

test("corrupt regular settings fail closed until explicitly repaired; unsafe targets stay protected", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  const hook = f.events.get("before_agent_start");
  await handler("workflow disabled", f.ctx);
  const settingsDir = path.join(f.agentDir, "useful-skills", "workflow-settings");
  const external = "external higher-priority instruction";
  const disabled = (await hook({ systemPrompt: [external], prompt: "fix" }, f.ctx)).systemPrompt;
  await writeFile(path.join(settingsDir, "workflow.json"), "invalid JSON");
  const unknown = (await hook({ systemPrompt: disabled, prompt: "/skill:us-ignore-workflow" }, f.ctx)).systemPrompt;
  assert.equal(unknown[0], external);
  assert.ok(unknown.some(line => line.includes("could not safely determine the profile workflow mode")));
  assert.ok(!unknown.some(line => line.includes("fast lane is active") || line.includes("permit that required stage")));
  assert.equal(await hook({ systemPrompt: unknown, prompt: "fix" }, f.ctx), undefined);
  await handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown \(Workflow setting must contain a JSON boolean/);
  assert.match(f.messages.at(-1).message, /Research: saved enabled, effective unknown \(workflow setting unreadable\)/);
  assert.equal(f.messages.at(-1).level, "warning");
  await handler("workflow enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /workflow enabled for this OMP profile/);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.workflow, true);

  await writeFile(path.join(settingsDir, "review.json"), "invalid JSON");
  const selective = (await hook({ systemPrompt: unknown, prompt: "fix" }, f.ctx)).systemPrompt;
  assert.ok(selective.some(line => line.includes("automatic review stage could not be read safely")));
  assert.ok(selective.some(line => line.includes("automatic security-review stage enabled")));
  await handler("stage review disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /review disabled for this OMP profile/);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false);
  const sentinel = path.join(f.root, "sentinel.json");
  await writeFile(sentinel, "false");
  await rm(path.join(settingsDir, "review.json"));
  await symlink(sentinel, path.join(settingsDir, "review.json"));
  await handler("stage review enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change review/);
  assert.equal(f.messages.at(-1).level, "error");
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, undefined);
  assert.equal(await readFile(sentinel, "utf8"), "false");
});
test("a missing agent profile never turns a read failure into enabled or disabled stage authority", async t => {
  const f = await fixture(t);
  await rm(f.agentDir, { recursive: true });
  const hook = f.events.get("before_agent_start");
  const guidance = (await hook({ systemPrompt: ["keep external guidance"], prompt: "fix" }, f.ctx)).systemPrompt;
  assert.equal(guidance[0], "keep external guidance");
  assert.ok(guidance.some(line => line.includes("could not safely determine the profile workflow mode")));
  assert.ok(!guidance.some(line => line.includes("fast lane is active") || line.includes("permit that required stage")));
  await f.commands.get("useful-skills").handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown \(/);
  await f.commands.get("useful-skills").handler("stage plan disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change plan/);
  assert.equal(f.messages.at(-1).level, "error");
});

test("a settings write failure is visible and leaves the profile choice unchanged", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await chmod(f.agentDir, 0o500);
  try {
    await handler("stage review disabled", f.ctx);
    assert.match(f.messages.at(-1).message, /Cannot change review/);
    assert.equal(f.messages.at(-1).level, "error");
    const report = await readWorkflowSettings({ agentDir: f.agentDir });
    assert.equal(report.values.review, true);
  } finally {
    await chmod(f.agentDir, 0o700);
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

test("explicit graph test reports observed storage and a bounded, redacted query without an agent turn", async t => {
  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      let releaseBuild;
      const buildPending = new Promise(resolve => { releaseBuild = resolve; });
      const actions = [];
      const f = await fixture(t, hasUI, async (args, options) => {
        actions.push(args.action);
        assert.equal(options.cwd, f.root);
        assert.equal(options.agentDir, f.agentDir);
        if (args.action === "build") {
          await buildPending;
          return {
            ok: true, active: { generation: "generation-41", graph: path.join(f.agentDir, "useful-skills/memory/graph.json") },
            snapshot: { nodes: 13, edges: 5, sources: 2 },
          };
        }
        assert.equal(args.action, "query");
        assert.equal(args.query, "main", "the diagnostic targets a common graph symbol");
        return { ok: true, active: { generation: "generation-41" }, output: "main() calls helper().\ntoken=" + "s".repeat(24) + "\n" + "x".repeat(8_000), outputTruncated: true };
      });
      const handler = f.commands.get("useful-skills").handler;
      await handler("workflow disabled", f.ctx);
      await handler("stage graphify-memory disabled", f.ctx);
      f.messages.length = 0;
      const running = f.commands.get("useful-skills").handler(" \tgraph   test ", f.ctx);
      assert.match(f.messages[0].message, /may set up pinned dependencies.*outside the checkout/i);
      assert.deepEqual(actions, ["build"], "query waits for successful build");
      releaseBuild();
      await running;
      assert.deepEqual(actions, ["build", "query"]);
      assert.match(f.messages[1].message, /generation-41.*13 nodes.*5 edges.*2 source files/);
      assert.match(f.messages[1].message, new RegExp(f.agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(f.messages[2].message, /Graphify query "main" output.*main\(\) calls helper\(\)/s);
      assert.match(f.messages[2].message, /Graphify output truncated/);
      assert.ok(f.messages[2].message.includes("token=[REDACTED]"));
      assert.match(f.messages[2].message, /\[display truncated\]$/);
      assert.ok(Buffer.byteLength(f.messages[2].message) <= 4_096);
      assert.doesNotMatch(f.messages[2].message, /s{24}/);
      if (hasUI) assert.ok(f.messages.every(message => message.level === "info"));
      else assert.ok(f.messages.every(message => message.options?.triggerTurn === false));
      assert.deepEqual(await readdir(f.root), [], "the command itself writes no checkout files");
    });
  }
});

test("graph test keeps build failure, query failure, no matches, empty result and generation mismatch distinct", async t => {
  const cases = [
    { build: { ok: false, error: "dependency unavailable" }, expected: /build failed: dependency unavailable/, actions: ["build"] },
    { build: { ok: true, active: { generation: "one", graph: "/profile/graph.json" }, snapshot: { nodes: 0, edges: 0, sources: 0 } }, query: { ok: false, error: "timed out" }, expected: /query failed: timed out/, actions: ["build", "query"] },
    { build: { ok: true, active: { generation: "one", graph: "/profile/graph.json" }, snapshot: { nodes: 0, edges: 0, sources: 0 } }, query: { ok: true, active: { generation: "two" }, output: "stale answer" }, expected: /generation changed from one to two/, actions: ["build", "query"] },
    { build: { ok: true, active: { generation: "one", graph: "/profile/graph.json" }, snapshot: { nodes: 3, edges: 3, sources: 1 } }, query: { ok: true, active: { generation: "one" }, output: "No matching nodes found." }, expected: /query "main" returned no matches:\nNo matching nodes found\./, actions: ["build", "query"] },
    { build: { ok: true, active: { generation: "one", graph: "/profile/graph.json" }, snapshot: { nodes: 0, edges: 0, sources: 0 } }, query: { ok: true, active: { generation: "one" }, output: "" }, expected: /query "main" returned no output.*no relationships are claimed/, actions: ["build", "query"] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.expected.source, async t => {
      const actions = [];
      const f = await fixture(t, true, async ({ action }) => {
        actions.push(action);
        return action === "build" ? scenario.build : scenario.query;
      });
      await f.commands.get("useful-skills").handler("graph test", f.ctx);
      assert.deepEqual(actions, scenario.actions);
      assert.match(f.messages.at(-1).message, scenario.expected);
      assert.equal(f.messages.at(-1).level, scenario.query?.ok === true && scenario.query.active.generation === "one" ? "info" : "error");
      if (scenario.query?.active?.generation === "two") assert.doesNotMatch(f.messages.at(-1).message, /stale answer/);
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});

test("graph diagnostics redact and bound stage failures; passive commands cannot start graph setup", async t => {
  const actions = [];
  const f = await fixture(t, true, async ({ action }) => {
    actions.push(action);
    if (action === "status") return { ok: false, native: { ok: false, error: "Unavailable" }, graph: { ok: true, available: false } };
    throw new Error("token=" + "z".repeat(24) + " " + "x".repeat(12_000));
  });
  const handler = f.commands.get("useful-skills").handler;
  await handler("help", f.ctx);
  await handler("doctor", f.ctx);
  await handler("graph", f.ctx);
  await handler("graph test extra", f.ctx);
  f.selectResponses.push("Help");
  await handler("", f.ctx);
  await f.events.get("session_start")({}, f.ctx);
  assert.deepEqual(actions, ["status"], "doctor reads status; no passive command builds or queries");
  await handler("graph test", f.ctx);
  assert.deepEqual(actions, ["status", "build"]);
  assert.equal(f.messages.at(-1).level, "error");
  assert.ok(f.messages.at(-1).message.includes("token=[REDACTED]"));
  assert.match(f.messages.at(-1).message, /\[display truncated\]$/);
  assert.ok(Buffer.byteLength(f.messages.at(-1).message) <= 4_096);
  assert.doesNotMatch(f.messages.at(-1).message, /z{24}/);
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
test("headless help, status, stage menus, and cancellation behave without surprise writes or model turns", async t => {
  const f = await fixture(t, false);
  const handler = f.commands.get("useful-skills").handler;
  await handler("", f.ctx);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  assert.match(f.messages.at(-1).message, /\/useful-skills stage/);
  assert.match(f.messages.at(-1).message, /\/useful-skills status/);
  const initial = await readWorkflowSettings({ agentDir: f.agentDir });
  const interactive = { ...f.ctx, hasUI: true };
  const count = f.messages.length;
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  f.selectResponses.push("Update");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.ok(f.selections.at(-2).choices.includes("Stages"));
  assert.deepEqual(f.selections.at(-1), { title: "Update", choices: ["Check", "Install"] });
  f.selectResponses.push("Workflow (enabled)");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.deepEqual(f.selections.at(-1), { title: "Workflow: enabled", choices: ["Enabled", "Disabled"] });
  f.selectResponses.push("Stages");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.ok(f.selections.at(-1).choices.includes("Review (enabled)"));
  f.selectResponses.push("Stages", "Review (enabled)");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.deepEqual(await readdir(f.agentDir), [], "cancelling menus must not create profile settings");
  assert.deepEqual(f.selections.at(-1), { title: "Review: enabled", choices: ["Enabled", "Disabled"] });
  assert.deepEqual((await readWorkflowSettings({ agentDir: f.agentDir })).values, initial.values);

  f.selectResponses.push("Stages", "Review (enabled)", "Disabled");
  await handler("", interactive);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false);
  f.selectResponses.push("Status");
  await handler("", interactive);
  assert.match(f.messages.at(-1).message, /Review: saved disabled, effective disabled/);
  f.selectResponses.push("Workflow (enabled)", "Disabled");
  await handler("", interactive);
  assert.ok((await f.events.get("before_agent_start")({ systemPrompt: [], prompt: "fix a bug" }, f.ctx)).systemPrompt.some(line => line.includes("fast lane is active")));
  f.selectResponses.push("Workflow (disabled)", "Enabled");
  await handler("", interactive);
  assert.ok((await f.events.get("before_agent_start")({ systemPrompt: [], prompt: "fix a bug" }, f.ctx)).systemPrompt.some(line => line.includes("automatic review stage disabled")));
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
