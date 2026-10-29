import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { workspaceMemoryPaths } from "../memory-paths.js";

const SERVER = fileURLToPath(new URL("../opencode/mcp-server.js", import.meta.url));

/** Temp HOME/XDG dirs, two projects, and a private data dir; never the real user dirs. */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-memory-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const project = path.join(root, "project");
  const other = path.join(root, "other");
  const data = path.join(root, "data");
  const environment = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "share"),
  };
  for (const directory of [project, other, data, environment.HOME]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  return { project, other, data, environment };
}

/** Start the MCP server in `cwd` and return a minimal newline-delimited JSON-RPC client. */
function connect(t, { cwd, environment }) {
  const child = spawn(process.execPath, [SERVER], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
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
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once("close", resolve));
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
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    send({ method: "notifications/initialized" });
  }

  async function call(id, name, args = {}) {
    const { result } = await request(id, "tools/call", { name, arguments: args });
    return { isError: result.isError, text: result.content[0].text };
  }

  return { init, request, call };
}

test("the OpenCode memory server keeps facts per workspace in the configured data dir", async t => {
  const f = await fixture(t);
  const environment = { ...f.environment, USEFUL_SKILLS_DATA: f.data };

  const client = connect(t, { cwd: f.project, environment });
  await client.init();
  const tools = (await client.request(2, "tools/list")).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ["memory_status", "memory_search", "memory_save"]);
  assert.match(tools[0].description, /OpenCode facts/);

  const saved = await client.call(3, "memory_save", { content: "Use meters." });
  assert.equal(saved.isError, false, saved.text);
  const found = JSON.parse((await client.call(4, "memory_search", { query: "meters" })).text);
  assert.equal(found.observation.items[0].content, "Use meters.");

  const paths = await workspaceMemoryPaths({ cwd: f.project, agentDir: f.data });
  assert.equal((await readdir(path.join(paths.directory, "opencode-facts"))).length, 1);

  // An absolute USEFUL_SKILLS_WORKSPACE overrides the launch directory; a relative one is ignored.
  const elsewhere = connect(t, { cwd: f.project, environment: { ...environment, USEFUL_SKILLS_WORKSPACE: f.other } });
  await elsewhere.init();
  assert.equal(JSON.parse((await elsewhere.call(2, "memory_search", { query: "meters" })).text).observation.count, 0);

  const relative = connect(t, { cwd: f.project, environment: { ...environment, USEFUL_SKILLS_WORKSPACE: "other" } });
  await relative.init();
  assert.equal(JSON.parse((await relative.call(2, "memory_search", { query: "meters" })).text).observation.count, 1);
});

test("without an install record or data override, tool calls explain how to install", async t => {
  const f = await fixture(t);
  const client = connect(t, { cwd: f.project, environment: f.environment });
  await client.init();

  const status = await client.call(2, "memory_status");
  assert.equal(status.isError, true);
  assert.match(status.text, /install --host opencode/);
  assert.deepEqual(await readdir(f.data), []);
});
