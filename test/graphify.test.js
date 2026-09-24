import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGraphify, graphStatus, workspaceMemoryPaths } from "../graphify.js";

async function fixturePaths(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "us-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const agentDir = await mkdtemp(path.join(os.tmpdir(), "us-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  return { workspace, agentDir };
}

function graph(nodes = [{ id: "main", source_file: "main.py" }], edges = []) {
  return JSON.stringify({ nodes, edges });
}

async function installActive(paths, contents, metadata = {}) {
  const generation = "generation-test";
  const directory = path.join(paths.generations, generation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "graph.json"), contents, { mode: 0o600 });
  await writeFile(path.join(directory, "snapshot.json"), `${JSON.stringify({ ...metadata, generation })}\n`, { mode: 0o600 });
  await writeFile(paths.current, `${JSON.stringify({ generation })}\n`, { mode: 0o600 });
  return { generation, directory };
}

function graphService(runner) {
  return createGraphify({
    dependencyStatus: async () => ({ ready: true, state: "ready" }),
    ensureDependencies: async () => ({ python: "/managed/python", version: "0.9.65" }),
    runProcess: runner,
  });
}

test("graph status derives an uncreated external path", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  const status = await graphStatus({ cwd: workspace, agentDir });

  assert.match(paths.directory, /useful-skills[\\/]memory[\\/][a-f0-9]{64}$/);
  assert.equal(paths.graph, undefined);
  assert.equal(status.ok, true);
  assert.equal(status.available, false);
  assert.equal(existsSync(paths.directory), false);
});

test("workspace memory rejects a profile inside the checkout", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "us-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const agentDir = path.join(workspace, "profile");
  await mkdir(agentDir);

  await assert.rejects(
    workspaceMemoryPaths({ cwd: workspace, agentDir }),
    /outside the workspace/i,
  );
});

test("workspace memory rejects a symlinked profile", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  const linkRoot = await mkdtemp(path.join(os.tmpdir(), "us-link-"));
  t.after(() => rm(linkRoot, { recursive: true, force: true }));

  const link = path.join(linkRoot, "profile");
  await symlink(agentDir, link);

  await assert.rejects(workspaceMemoryPaths({ cwd: workspace, agentDir: link }), /symbolic links/i);
});

test("graph status rejects corrupt ids, edge references, and escaping sources", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  await installActive(paths, graph([{ id: "main", source_file: "../main.py" }]));

  const status = await graphStatus({ cwd: workspace, agentDir });

  assert.equal(status.available, false);
  assert.match(status.error, /source file/i);
});

test("graph status rejects dangling edge references", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  await installActive(paths, graph([{ id: "main", source_file: "main.py" }], [{ source: "main", target: "missing", relation: "calls" }]));

  const status = await graphStatus({ cwd: workspace, agentDir });

  assert.equal(status.available, false);
  assert.match(status.error, /edges/i);
});

test("build activates graph and metadata together in an isolated environment", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  const calls = [];
  const service = graphService(async (file, args, options) => {
    calls.push({ file, args, options });

    if (args[3] === "extract") {
      const output = args.at(-1);
      await mkdir(path.join(output, "graphify-out"), { recursive: true });
      await writeFile(path.join(output, "graphify-out", "graph.json"), graph());

      return { stdout: "extracted", stderr: "" };
    }

    throw new Error("unexpected command");
  });

  const result = await service.buildGraph({ cwd: workspace, agentDir });
  const active = JSON.parse(await readFile(result.active.pointer, "utf8"));
  const activeGraph = JSON.parse(await readFile(result.active.graph, "utf8"));
  const activeMetadata = JSON.parse(await readFile(result.active.snapshot, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(calls[0].options.cwd, result.paths.directory);
  assert.equal(calls[0].options.env.GRAPHIFY_QUERY_LOG_DISABLE, "1");
  assert.equal(calls[0].options.env.GRAPHIFY_DEBUG, undefined);
  assert.equal(calls[0].options.env.GRAPHIFY_FOLLOW_SYMLINKS, undefined);
  assert.equal(calls[0].options.env.HOME.startsWith(result.paths.runtime), true);
  assert.equal(activeGraph.nodes[0].id, "main");
  assert.equal(activeMetadata.generation, active.generation);

  assert.equal(activeMetadata.sources, 1);
});

test("failed builds preserve the prior generation and metadata", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  let build = 0;
  const service = graphService(async (_file, args) => {
    const output = args.at(-1);
    await mkdir(path.join(output, "graphify-out"), { recursive: true });
    build += 1;

    await writeFile(
      path.join(output, "graphify-out", "graph.json"),
      build === 1 ? graph() : graph([{ id: "main", source_file: "../escape.py" }]),
    );

    return { stdout: "", stderr: "" };
  });

  const first = await service.buildGraph({ cwd: workspace, agentDir });
  const before = await readFile(first.active.pointer, "utf8");
  const second = await service.buildGraph({ cwd: workspace, agentDir });
  const after = await readFile(first.active.pointer, "utf8");

  assert.equal(second.ok, false);
  assert.equal(after, before);
  assert.match(second.error, /source file/i);
});

test("build rejects an outside-root source symlink before activation", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "us-external-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const external = path.join(externalRoot, "external.py");
  await writeFile(external, "def external(): pass\n");
  await symlink(external, path.join(workspace, "linked.py"));

  const service = graphService(async (_file, args) => {
    const output = args.at(-1);
    await mkdir(path.join(output, "graphify-out"), { recursive: true });
    await writeFile(path.join(output, "graphify-out", "graph.json"), graph([{ id: "linked", source_file: "linked.py" }]));

    return { stdout: "", stderr: "" };
  });

  const result = await service.buildGraph({ cwd: workspace, agentDir });

  assert.equal(result.ok, false);
  assert.match(result.error, /outside the workspace/i);
});

test("build rejects generated output sources", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await mkdir(path.join(workspace, "generated"));
  await writeFile(path.join(workspace, "generated", "schema.generated.py"), "def generated(): pass\n");

  const service = graphService(async (_file, args) => {
    const output = args.at(-1);
    await mkdir(path.join(output, "graphify-out"), { recursive: true });
    await writeFile(path.join(output, "graphify-out", "graph.json"), graph([{ id: "generated", source_file: "generated/schema.generated.py" }]));

    return { stdout: "", stderr: "" };
  });

  const result = await service.buildGraph({ cwd: workspace, agentDir });

  assert.equal(result.ok, false);
  assert.match(result.error, /generated output/i);
});

test("query uses one immutable generation and truncates UTF-8 output by bytes", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  const active = await installActive(paths, graph(), { generation: "generation-test" });
  const long = "€".repeat(4_000);
  const service = graphService(async (_file, args, options) => {
    assert.equal(args[5], "--graph");
    assert.equal(args[6], path.join(active.directory, "graph.json"));
    assert.equal(options.cwd, paths.directory);

    return { stdout: long, stderr: "diagnostic ".repeat(2_000) };
  });

  const result = await service.queryGraph({ cwd: workspace, agentDir, query: "Where is main?" });

  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 8 * 1024);
  assert.equal(result.output.includes("\uFFFD"), false);
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 8 * 1024);
  assert.equal(result.stderrTruncated, true);
});

test("query rejects invalid input and reports runner cancellation without changing a graph", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  const active = await installActive(paths, graph());

  let calls = 0;
  const service = graphService(async () => {
    calls += 1;
    throw new Error("Process cancelled.");
  });

  const invalid = await service.queryGraph({ cwd: workspace, agentDir, query: " " });
  const cancelled = await service.queryGraph({
    cwd: workspace,
    agentDir,
    query: "main",
    signal: new AbortController().signal,
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /non-empty/i);
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled/i);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).generation, active.generation);
});

test("query reports timeout errors without treating diagnostic stderr as failure", async (t) => {
  const { workspace, agentDir } = await fixturePaths(t);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  await installActive(paths, graph());
  const service = graphService(async () => {
    throw new Error("Process timed out after 10000ms.");
  });

  const result = await service.queryGraph({ cwd: workspace, agentDir, query: "main" });

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
});
