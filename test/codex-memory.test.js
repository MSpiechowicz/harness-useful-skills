import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { workspaceMemoryPaths } from "../graphify.js";

const SERVER = fileURLToPath(new URL("../codex/mcp-server.js", import.meta.url));
const TOOLS = ["memory_status", "memory_search", "memory_save", "graph_build", "graph_query"];

/** A temp HOME, two projects, and a private data dir; the environment holds only what Codex passes to MCP servers. */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-codex-memory-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const project = path.join(root, "project");
  const other = path.join(root, "other");
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  for (const directory of [project, other, data, home]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const environment = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TERM: "dumb", USER: "tester", LOGNAME: "tester", SHELL: "/bin/sh" };
  return { root, project, other, data, home, environment };
}

/** Start the MCP server in `cwd` and return a minimal newline-delimited JSON-RPC client. */
function connect(t, { cwd, environment }) {
  const child = spawn(process.execPath, [SERVER], { cwd, env: { ...environment, PWD: cwd }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve([code, signal])));
  const pending = new Map();
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function request(id, method, params) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request ${id} timed out`)), 15_000);
      pending.set(id, value => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    send({ id, method, params });
    return response;
  }

  async function init() {
    const response = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-test", version: "1" } });
    send({ method: "notifications/initialized" });
    return response;
  }

  async function call(id, name, args = {}) {
    const { result } = await request(id, "tools/call", { name, arguments: args });
    return { isError: result.isError, text: result.content[0].text };
  }

  return { child, exited, init, request, call };
}

/** The saved-fact files in the Codex facts store for `project` under `data`. */
async function codexFacts(project, data) {
  const paths = await workspaceMemoryPaths({ cwd: project, agentDir: data });
  return readdir(path.join(paths.directory, "codex-facts"));
}

test("the Codex memory server serves the five tools and keeps facts per workspace in USEFUL_SKILLS_DATA", async t => {
  const f = await fixture(t);
  const environment = { ...f.environment, USEFUL_SKILLS_DATA: f.data };

  const client = connect(t, { cwd: f.project, environment });
  const initialized = await client.init();
  assert.equal(initialized.error, undefined);
  assert.ok(initialized.result.capabilities.tools);

  const tools = (await client.request(2, "tools/list")).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), TOOLS);
  assert.match(tools[0].description, /Codex facts/);

  const status = await client.call(3, "memory_status");
  assert.equal(status.isError, false, status.text);
  assert.equal(JSON.parse(status.text).ok, true);

  const saved = await client.call(4, "memory_save", { content: "Use meters." });
  assert.equal(saved.isError, false, saved.text);
  const found = JSON.parse((await client.call(5, "memory_search", { query: "meters" })).text);
  assert.equal(found.observation.items[0].content, "Use meters.");
  assert.equal((await codexFacts(f.project, f.data)).length, 1);

  // An absolute USEFUL_SKILLS_WORKSPACE overrides the launch directory; a relative one is ignored.
  const elsewhere = connect(t, { cwd: f.project, environment: { ...environment, USEFUL_SKILLS_WORKSPACE: f.other } });
  await elsewhere.init();
  assert.equal(JSON.parse((await elsewhere.call(2, "memory_search", { query: "meters" })).text).observation.count, 0);

  const relative = connect(t, { cwd: f.project, environment: { ...environment, USEFUL_SKILLS_WORKSPACE: "other" } });
  await relative.init();
  assert.equal(JSON.parse((await relative.call(2, "memory_search", { query: "meters" })).text).observation.count, 1);
});

test("a relative USEFUL_SKILLS_DATA fails tool calls with a printable reason", async t => {
  const f = await fixture(t);
  const client = connect(t, { cwd: f.project, environment: { ...f.environment, USEFUL_SKILLS_DATA: "data" } });
  await client.init();

  const status = await client.call(2, "memory_status");
  assert.equal(status.isError, true);
  assert.equal(status.text, "USEFUL_SKILLS_DATA must be an absolute path.");
  assert.deepEqual(await readdir(f.data), []);
});

test("without USEFUL_SKILLS_DATA, facts live in $HOME/.codex/useful-skills/data", async t => {
  const f = await fixture(t);
  const fallback = path.join(f.home, ".codex", "useful-skills", "data");
  await mkdir(fallback, { recursive: true, mode: 0o700 });

  const client = connect(t, { cwd: f.project, environment: f.environment });
  await client.init();

  const saved = await client.call(2, "memory_save", { content: "Use meters." });
  assert.equal(saved.isError, false, saved.text);
  assert.equal((await codexFacts(f.project, fallback)).length, 1);
});

test("a missing data directory fails tool calls without creating it or printing its path", async t => {
  const f = await fixture(t);
  const client = connect(t, { cwd: f.project, environment: f.environment });
  await client.init();

  const status = await client.call(2, "memory_status");
  assert.equal(status.isError, true);
  assert.match(status.text, /Codex project root or Useful Skills data directory cannot be resolved/);
  assert.ok(!status.text.includes(f.root), status.text);
  assert.deepEqual(await readdir(f.home), []);
});

test("the Codex memory server exits on SIGTERM", async t => {
  const f = await fixture(t);
  const client = connect(t, { cwd: f.project, environment: { ...f.environment, USEFUL_SKILLS_DATA: f.data } });
  await client.init();

  client.child.kill("SIGTERM");
  assert.deepEqual(await client.exited, [128 + os.constants.signals.SIGTERM, null]);
});
