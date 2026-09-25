import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const server = fileURLToPath(new URL("../claude/mcp-server.js", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-memory-"));
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  const data = path.join(root, "data");
  await Promise.all([mkdir(project), mkdir(other), mkdir(data)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, other, data };
}

function connect(t, project, data) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const pending = new Map();
  const queue = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    let end;
    while ((end = output.indexOf("\n")) >= 0) {
      const response = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter(response);
      } else queue.push(response);
    }
  });
  const close = async () => {
    child.stdin.end();
    await new Promise(resolve => child.once("close", resolve));
  };
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill();
      await new Promise(resolve => child.once("close", resolve));
    }
  });
  function send(message) {
    child.stdin.write(`${typeof message === "string" ? message : JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function request(id, method, params) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request ${id} timed out`)), 15_000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
    });
    send({ id, method, ...(params === undefined ? {} : { params }) });
    return response;
  }
  async function init() {
    const response = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(response.result.protocolVersion, "2025-06-18");
    send({ method: "notifications/initialized" });
  }
  async function call(id, name, args = {}) {
    const response = await request(id, "tools/call", { name, arguments: args });
    assert.equal(response.error, undefined);
    const text = response.result.content[0].text;
    const hostError = "Memory operation failed; check host roots and private storage permissions.";
    if (response.result.isError && text === hostError) {
      return { ...response.result, errorText: text };
    }
    return { ...response.result, value: JSON.parse(text) };
  }
  return { child, send, request, init, call, close, queue };
}

test("stdio lifecycle, literal fact search, concurrent durable writes, restart and project isolation", async t => {
  const { project, other, data } = await fixture(t);
  const first = connect(t, project, data);
  assert.equal((await first.request(0, "tools/list")).error.code, -32002);
  await first.init();
  const list = await first.request(2, "tools/list");
  assert.deepEqual(list.result.tools.map(tool => tool.name), ["memory_status", "memory_search", "memory_save", "graph_build", "graph_query"]);
  assert.deepEqual(await readdir(data), []);
  const initialStatus = await first.call(3, "memory_status");
  assert.equal(initialStatus.value.native.observation.active, true);
  assert.equal(initialStatus.value.native.observation.writable, "unknown");
  assert.equal((await first.call(4, "memory_search", { query: "meter" })).value.observation.count, 0);
  assert.deepEqual(await readdir(data), []);

  const writes = await Promise.all(Array.from({ length: 12 }, (_, n) => first.call(10 + n, "memory_save", { content: `Unit ${n}: meters.` })));
  assert.ok(writes.every(result => result.isError === false && result.value.observation.stored === 1));
  assert.equal((await first.call(32, "memory_status")).value.native.observation.writable, "unknown");
  assert.equal((await first.call(30, "memory_search", { query: "meters" })).value.observation.items.length, 8);
  assert.equal((await first.call(31, "memory_search", { query: "Unit 3:" })).value.observation.items[0].content, "Unit 3: meters.");
  await first.close();

  const second = connect(t, project, data);
  await second.init();
  assert.equal((await second.call(2, "memory_search", { query: "Unit 3:" })).value.observation.items[0].content, "Unit 3: meters.");
  await second.close();

  const isolated = connect(t, other, data);
  await isolated.init();
  assert.equal((await isolated.call(2, "memory_search", { query: "meters" })).value.observation.count, 0);
  assert.equal((await isolated.call(3, "memory_status")).value.native.observation.active, true);
  await isolated.close();

  const memory = path.join(data, "useful-skills", "memory");
  const [projectHash] = await readdir(memory);
  const facts = path.join(memory, projectHash, "claude-facts");
  const files = await readdir(facts);
  assert.equal(files.length, 12);
  for (const file of files) {
    assert.equal((await stat(path.join(facts, file))).mode & 0o077, 0);
    assert.equal(typeof JSON.parse(await readFile(path.join(facts, file), "utf8")).content, "string");
  }
});

test("protocol failures, secret refusal, invalid fields and unavailable graph remain explicit", async t => {
  const { project, data } = await fixture(t);
  const client = connect(t, project, data);
  client.send("{invalid json");
  const malformed = await client.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(malformed.result.protocolVersion, "2025-06-18");
  assert.equal(client.queue[0].error.code, -32700);
  client.send({ method: "notifications/initialized" });
  assert.equal((await client.request(2, "missing")).error.code, -32601);
  assert.equal((await client.request(3, "tools/call", { name: "unknown", arguments: {} })).error.code, -32602);
  assert.equal((await client.request(7, "tools/call", { name: "memory_status", arguments: { action: "build" } })).error.code, -32602);
  const cancelled = client.request(8, "tools/call", { name: "graph_build", arguments: {} });
  client.send({ method: "notifications/cancelled", params: { requestId: 8, reason: "Stop" } });
  assert.equal((await cancelled).result.isError, true);
  const secret = await client.call(4, "memory_save", { content: `token=${"x".repeat(24)}` });
  assert.equal(secret.isError, true);
  assert.match(secret.value.error, /secret-shaped/);
  assert.equal((await client.call(5, "memory_save", { content: "Use meters.", cwd: project })).isError, true);
  const graph = await client.call(6, "graph_query", { query: "unit" });
  assert.equal(graph.isError, true);
  assert.match(graph.value.error, /No active graph/);
  assert.deepEqual(await readdir(data), []);
  await client.close();
});

test("independent server processes save facts without lost updates", async t => {
  const { project, data } = await fixture(t);
  const first = connect(t, project, data);
  const second = connect(t, project, data);
  await Promise.all([first.init(), second.init()]);
  const results = await Promise.all([
    first.call(2, "memory_save", { content: "Priority: accessibility." }),
    second.call(2, "memory_save", { content: "Priority: maintainability." }),
  ]);
  assert.ok(results.every(result => !result.isError));
  const found = await first.call(3, "memory_search", { query: "Priority:" });
  assert.deepEqual(found.value.observation.items.map(item => item.content).sort(), ["Priority: accessibility.", "Priority: maintainability."]);
  await Promise.all([first.close(), second.close()]);
});

test("maximum-length escaped facts remain searchable after confirmed persistence", async t => {
  const { project, data } = await fixture(t);
  const client = connect(t, project, data);
  await client.init();
  const content = "\u0000".repeat(16_384);
  assert.ok(Buffer.byteLength(JSON.stringify({ content })) > 64 * 1024);
  const saved = await client.call(2, "memory_save", { content });
  assert.equal(saved.isError, false);
  assert.equal(saved.value.observation.stored, 1);
  const found = await client.call(3, "memory_search", { query: "\u0000\u0000" });
  assert.equal(found.isError, false);
  assert.equal(found.value.observation.items[0].content, content);
  await client.close();
});

test("concurrent saves at the final storage slot cannot acknowledge an unsearchable fact", async t => {
  const { project, data } = await fixture(t);
  const seed = connect(t, project, data);
  await seed.init();
  assert.equal((await seed.call(2, "memory_save", { content: "Seed fact." })).isError, false);
  await seed.close();

  const memory = path.join(data, "useful-skills", "memory");
  const [hash] = await readdir(memory);
  const facts = path.join(memory, hash, "claude-facts");
  const source = path.join(facts, "00000.json");
  for (let start = 1; start < 9_999; start += 200) {
    const last = Math.min(start + 200, 9_999);
    await Promise.all(Array.from({ length: last - start }, (_, offset) =>
      link(source, path.join(facts, `${String(start + offset).padStart(5, "0")}.json`))));
  }

  const first = connect(t, project, data);
  const second = connect(t, project, data);
  await Promise.all([first.init(), second.init()]);
  const results = await Promise.all([
    first.call(2, "memory_save", { content: "Near-cap fact A." }),
    second.call(2, "memory_save", { content: "Near-cap fact B." }),
  ]);
  const accepted = results.filter(result => !result.isError);
  const rejected = results.filter(result => result.isError);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].value.observation.stored, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].value.error, /storage is full/);
  const found = await first.call(3, "memory_search", { query: "Near-cap fact" });
  assert.equal(found.isError, false);
  assert.equal(found.value.observation.count, 1);
  assert.ok(["Near-cap fact A.", "Near-cap fact B."].includes(found.value.observation.items[0].content));
  assert.equal((await readdir(facts)).length, 10_000);
  await Promise.all([first.close(), second.close()]);
});

test("workspace and data-root violations fail closed without writing into project", async t => {
  const { root, project, data } = await fixture(t);
  const nestedData = path.join(project, "plugin-data");
  await mkdir(nestedData);
  const nested = connect(t, project, nestedData);
  await nested.init();
  const nestedResult = await nested.call(2, "memory_save", { content: "Use meters." });
  assert.equal(nestedResult.isError, true);
  assert.match(nestedResult.value.error, /outside the workspace/);
  assert.deepEqual(await readdir(nestedData), []);
  await nested.close();

  const missing = connect(t, project, path.join(root, "not-present"));
  await missing.init();
  const secret = `token=${"x".repeat(24)}`;
  const missingResult = await missing.call(2, "memory_save", { content: secret });
  assert.equal(missingResult.isError, true);
  assert.equal(missingResult.errorText, "Memory operation failed; check host roots and private storage permissions.");
  assert.equal(missingResult.errorText.includes(secret), false);
  await missing.close();

  const alias = path.join(root, "data-alias");
  await symlink(data, alias);
  const linked = connect(t, project, alias);
  await linked.init();
  const linkedResult = await linked.call(2, "memory_save", { content: "Use meters." });
  assert.equal(linkedResult.isError, true);
  assert.equal(linkedResult.errorText, "Memory operation failed; check host roots and private storage permissions.");
  assert.deepEqual(await readdir(data), []);
  await linked.close();

  const valid = connect(t, project, data);
  await valid.init();
  assert.equal((await valid.call(2, "memory_save", { content: "Use meters." })).isError, false);
  await valid.close();
  const memory = path.join(data, "useful-skills", "memory");
  const [hash] = await readdir(memory);
  const facts = path.join(memory, hash, "claude-facts");
  await rm(facts, { recursive: true });
  await symlink(project, facts);
  const unsafe = connect(t, project, data);
  await unsafe.init();
  const unsafeSearch = await unsafe.call(2, "memory_search", { query: "meters" });
  assert.equal(unsafeSearch.isError, true);
  assert.match(unsafeSearch.value.error, /private non-symlink directory/);
  const unsafeSave = await unsafe.call(3, "memory_save", { content: "Another fact." });
  assert.equal(unsafeSave.isError, true);
  assert.match(unsafeSave.value.error, /private non-symlink directory/);
  assert.deepEqual(await readdir(project), ["plugin-data"]);
  await unsafe.close();
});
