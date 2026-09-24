import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/extension-fixture.js";

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
      if (hasUI) {
        assert.ok(f.messages.every(message => message.level === "info"));
      } else {
        assert.ok(f.messages.every(message => message.options?.triggerTurn === false));
      }
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
      if (scenario.query?.active?.generation === "two") {
        assert.doesNotMatch(f.messages.at(-1).message, /stale answer/);
      }
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});

test("graph diagnostics redact and bound stage failures; passive commands cannot start graph setup", async t => {
  const actions = [];
  const f = await fixture(t, true, async ({ action }) => {
    actions.push(action);
    if (action === "status") {
      return { ok: false, native: { ok: false, error: "Unavailable" }, graph: { ok: true, available: false } };
    }
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
