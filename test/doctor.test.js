import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctor } from "../doctor.js";

const inventory = { skills: 2, commands: 1, agents: 0, rules: 3 };

function report(memory) {
  return formatDoctor({ core: inventory, library: inventory, safety: true, memory });
}

test("doctor distinguishes disabled, unavailable, and failed native memory without inspecting profile paths", () => {
  const disabled = report({
    native: {
      ok: false,
      error: "Memory backend is off.",
      observation: { backend: "off", active: false, message: "Memory backend is off." },
    },
    graph: { available: false, dependency: { state: "missing" } },
  });
  assert.match(disabled, /Native: Disabled/);
  assert.match(disabled, /Graph: Not built/);
  assert.match(disabled, /Dependencies: Not installed/);

  const ready = report({
    native: { ok: true, observation: { backend: "local", active: true, message: "Memory backend is active." } },
    graph: { available: false, dependency: { state: "missing" } },
  });
  assert.match(ready, /Native: Ready/);

  const unavailable = report();
  assert.match(unavailable, /Native: Unavailable/);
  assert.match(unavailable, /terminal cannot inspect/i);

  const secret = "x".repeat(25);
  const failed = report({
    native: { observation: { error: `\u001b[31mtoken=${secret}\n${"detail ".repeat(80)}` } },
    graph: { available: false, dependency: { state: "missing" } },
  });
  assert.match(failed, /Native: Error/);
  assert.equal(failed.includes(secret), false);
  assert.doesNotMatch(failed, /\u001b/);
  assert.ok(failed.length < 900, "diagnostics stay bounded");
});

test("doctor reports graph and dependency observations without raw data dumps", () => {
  const notBuilt = report({
    native: { ok: true, observation: { active: true } },
    graph: { available: false, dependency: { state: "partial" } },
  });
  assert.match(notBuilt, /Graph: Not built/);
  assert.match(notBuilt, /Dependencies: Incomplete/);

  const failed = report({
    native: { ok: true, observation: { active: true }, paths: { directory: "/home/profile/useful-skills/memory" } },
    graph: {
      available: false,
      error: "graph metadata is invalid",
      paths: { current: "/home/profile/useful-skills/memory/current.json" },
      dependency: { state: "unknown", reason: "status lookup failed", versionRoot: "/home/profile/useful-skills/dependencies" },
    },
  });
  assert.match(failed, /Graph: Error/);
  assert.match(failed, /Dependencies: Error/);
  assert.doesNotMatch(failed, /\{\s*"|\/home\//);
});

test("doctor preserves ready graph counts and distinguishes unavailable dependency inspection", () => {
  const ready = report({
    native: { ok: true, observation: { active: true } },
    graph: { available: true, snapshot: { nodes: 12, edges: 9 }, dependency: { ready: true } },
  });
  assert.match(ready, /Graph: Ready — 12 nodes, 9 edges/);
  assert.match(ready, /Dependencies: Ready/);

  const unsupported = report({
    native: { ok: false, error: "Native memory status failed: storage unavailable" },
    graph: { available: false, dependency: { state: "unsupported", reason: "Platform is unsupported" } },
  });
  assert.match(unsupported, /Native: Error — Native memory status failed: storage unavailable/);
  assert.match(unsupported, /Dependencies: Unsupported — Platform is unsupported/);
  assert.doesNotMatch(unsupported, /Dependencies: Not installed/);

  const missingStatus = report({ ok: false, error: "Cannot inspect workspace" });
  assert.match(missingStatus, /Native: Unavailable/);
  assert.match(missingStatus, /Graph: Unavailable/);
  assert.match(missingStatus, /Dependencies: Unavailable/);
  assert.doesNotMatch(missingStatus, /Ready|Not built|Not installed/);
  assert.match(missingStatus, /Status: Error — Cannot inspect workspace/);
});
