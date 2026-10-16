import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serverModule = new URL("../mcp-memory-server.js", import.meta.url).href;
const rootsModule = new URL("../host-roots.js", import.meta.url).href;

// A host whose roots become available only after its first failed lookup.
const hostScript = `
import { startMemoryServer } from ${JSON.stringify(serverModule)};
import { resolveHostRoots } from ${JSON.stringify(rootsModule)};
let attempts = 0;
startMemoryServer({
  factsLabel: "Example",
  resolveContext: async () => {
    attempts += 1;
    if (attempts === 1) return { reason: "Example install record is missing." };
    return resolveHostRoots({
      workspace: process.env.PROJECT, data: process.env.DATA, label: "Example",
      facts: { label: "Example", backend: "example-local-facts", directory: "example-facts" },
    });
  },
});
`;

function connect(t, environment) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", hostScript], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());

  let output = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    let end;
    while ((end = output.indexOf("\n")) >= 0) {
      const response = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function request(id, method, params) {
    const response = new Promise(resolve => pending.set(id, resolve));
    send({ id, method, params });
    return response;
  }

  return { send, request };
}

test("a host's facts label, reason failures and facts backend reach MCP clients", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-memory-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  await Promise.all([mkdir(project), mkdir(data)]);

  const { send, request } = connect(t, { PROJECT: project, DATA: data });
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  send({ method: "notifications/initialized" });

  const listed = await request(2, "tools/list");
  const status = listed.result.tools.find(tool => tool.name === "memory_status");
  assert.equal(status.description, "Inspect local Example facts and the project graph without creating storage or installing dependencies.");

  const refused = await request(3, "tools/call", { name: "memory_status", arguments: {} });
  assert.deepEqual(refused.result, { content: [{ type: "text", text: "Example install record is missing." }], isError: true });

  const saved = await request(4, "tools/call", { name: "memory_save", arguments: { content: "retry works" } });
  assert.equal(saved.result.isError, false);
  assert.deepEqual(JSON.parse(saved.result.content[0].text).observation, { backend: "example-local-facts", stored: 1 });

  const found = await request(5, "tools/call", { name: "memory_search", arguments: { query: "retry" } });
  assert.deepEqual(JSON.parse(found.result.content[0].text).observation.items, [{ content: "retry works" }]);
});
