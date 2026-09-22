import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeMemory } from "../memory.js";

async function fixture(t, memory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-memory-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "profile");
  await mkdir(cwd);
  await mkdir(agentDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd, agentDir, memory };
}

test("unavailable memory reports notes location without writing or pretending to save", async t => {
  const ctx = await fixture(t);
  for (const args of [{ action: "status" }, { action: "save", content: "Use meters." }, { action: "search", query: "units" }]) {
    const result = await executeMemory(args, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error, /unavailable/i);
    assert.match(result.paths.notes, /notes\.md$/);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("secret-shaped saves are rejected before invoking native storage", async t => {
  let calls = 0;
  const ctx = await fixture(t, { save: async () => { calls++; return { backend: "local", stored: 1 }; } });
  for (const content of ["token=" + "x".repeat(24), "sk-" + "a".repeat(24), "Bearer " + "a".repeat(24)]) {
    const result = await executeMemory({ action: "save", content }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error, /secret-shaped/i);
    assert.equal(result.error.includes(content), false);
  }
  assert.equal(calls, 0);
});

test("native save confirms actual storage and preserves a durable fact", async t => {
  const facts = [];
  const ctx = await fixture(t, { save: async input => { facts.push(input); return { backend: "local", stored: 1 }; } });
  const result = await executeMemory({ action: "save", content: "Use ESM modules; keep dimensions in meters." }, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(facts, [{ content: "Use ESM modules; keep dimensions in meters." }]);
  assert.deepEqual(result.observation, { backend: "local", stored: 1 });
});

test("disabled, queued, zero and malformed saves never report confirmed persistence", async t => {
  const ctx = await fixture(t);
  for (const observation of [{ backend: "off", stored: 0 }, { backend: "local", stored: 0, queued: true }, { backend: "local", stored: 0 }, undefined]) {
    const result = await executeMemory({ action: "save", content: "Use meters." }, { ...ctx, memory: { save: async () => observation } });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});

test("native status distinguishes disabled backend from healthy availability", async t => {
  const ctx = await fixture(t);
  for (const active of [false, true]) {
    const observation = { backend: active ? "local" : "off", active, writable: active, searchable: active };
    const result = await executeMemory({ action: "status" }, { ...ctx, memory: { status: async () => observation } });
    assert.equal(result.ok, active);
    assert.deepEqual(result.native.observation, observation);
    assert.equal(result.graph.available, false);
  }
});

test("nullable inactive payloads preserve status and query behavior", async t => {
  const ctx = await fixture(t, {
    status: async () => ({ backend: "local", active: true }),
    search: async () => ({ backend: "local", count: 0, items: [] }),
  });
  const status = await executeMemory({ action: "status", query: null, content: null }, ctx);
  assert.equal(status.ok, true);
  assert.equal(status.graph.available, false);
  const search = await executeMemory({ action: "search", query: "units", content: null }, ctx);
  assert.equal(search.ok, true);
  assert.deepEqual(search.observation.items, []);
  const query = await executeMemory({ action: "query", query: "units", content: null }, ctx);
  assert.equal(query.ok, false);
  assert.match(query.error, /No active graph/);
});

test("conflicting payloads and unknown fields never reach storage", async t => {
  let calls = 0;
  const ctx = await fixture(t, {
    save: async () => { calls++; return { backend: "local", stored: 1 }; },
  });
  for (const args of [
    { action: "save", content: "Use meters.", query: "units" },
    { action: "save", content: "Use meters.", extra: null },
    { action: "save", content: "Use meters.", extra: undefined },
    { action: "save", content: null, query: null },
    { action: "save", content: " ", query: null },
    { action: "save", content: "Use meters.", query: "" },
  ]) assert.equal((await executeMemory(args, ctx)).ok, false);
  assert.equal(calls, 0);
});

test("search accepts a real empty result but not a disabled backend", async t => {
  const ctx = await fixture(t);
  for (const backend of ["off", "local"]) {
    const result = await executeMemory({ action: "search", query: "units" }, { ...ctx, memory: { search: async query => ({ backend, query, count: 0, items: [] }) } });
    assert.equal(result.ok, backend === "local");
    assert.equal(result.observation.count, 0);
  }
});

test("native backend errors remain explicit without implicit fallback writes", async t => {
  const fail = async () => { throw new Error("backend offline"); };
  const ctx = await fixture(t, { status: fail, search: fail, save: fail });
  for (const args of [{ action: "status" }, { action: "search", query: "units" }, { action: "save", content: "Use meters." }]) {
    const result = await executeMemory(args, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error, /backend offline/);
  }
});

test("invalid action, text and extra fields fail before invoking any backend", async t => {
  const fail = () => assert.fail("invalid request reached backend");
  const ctx = await fixture(t, { status: fail, search: fail, save: fail });
  const invalid = [null, [], {}, { action: "erase" }, { action: "status", query: "x" }, { action: "build", extra: true }, { action: "query" }, { action: "query", query: " " }, { action: "query", query: "x".repeat(4097) }, { action: "search" }, { action: "search", query: 7 }, { action: "save" }, { action: "save", content: "x".repeat(16385) }];
  for (const args of invalid) assert.equal((await executeMemory(args, ctx)).ok, false);
  assert.equal((await executeMemory({ action: "status" }, {})).ok, false);
  const missingGraph = await executeMemory({ action: "query", query: "units" }, ctx);
  assert.equal(missingGraph.ok, false);
  assert.match(missingGraph.error, /No active graph/);
});
