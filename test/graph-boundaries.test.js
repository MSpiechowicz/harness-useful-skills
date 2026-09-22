import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGraphify, workspaceMemoryPaths } from "../graphify.js";

const validGraph = { nodes: [{ id: "main", source_file: "main.py" }], edges: [] };
const externalNode = { id: "os", label: "os", file_type: "concept", type: "external", external: true, source_file: "" };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-graph-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "profile");
  await mkdir(workspace);
  await mkdir(agentDir);
  await writeFile(path.join(workspace, "main.py"), "def main(): pass\n");
  const paths = await workspaceMemoryPaths({ cwd: workspace, agentDir });
  return { root, workspace, agentDir, paths, options: { cwd: workspace, agentDir } };
}

async function seed(f, contents = validGraph) {
  const generation = "boundary-snapshot";
  const directory = path.join(f.paths.generations, generation);
  await mkdir(directory, { recursive: true });
  const graph = path.join(directory, "graph.json");
  const snapshot = path.join(directory, "snapshot.json");
  await writeFile(graph, JSON.stringify(contents));
  await writeFile(snapshot, JSON.stringify({ generation }));
  await writeFile(f.paths.current, JSON.stringify({ generation }));
  return { directory, graph, snapshot, generation };
}

function service(overrides = {}) {
  return createGraphify({
    dependencyStatus: async () => ({ ready: true, state: "ready" }),
    ensureDependencies: async () => ({ python: "/managed/python", version: "0.9.65" }),
    runProcess: async () => { throw new Error("Unexpected process invocation"); },
    ...overrides,
  });
}

async function extract(args, contents) {
  const directory = path.join(args.at(-1), "graphify-out");
  await mkdir(directory);
  await writeFile(path.join(directory, "graph.json"), JSON.stringify(contents));
  return { stdout: "", stderr: "" };
}

const pointerCases = [
  ["malformed JSON", "{", /pointer.*invalid/i],
  ["array pointer", "[]", /invalid generation/i],
  ["missing generation", "{}", /invalid generation/i],
  ["non-string generation", '{"generation":17}', /invalid generation/i],
  ["escaping generation", '{"generation":"../outside"}', /invalid generation/i],
  ["oversized pointer", " ".repeat(4097), /pointer.*safety limit/i],
];
for (const [name, contents, error] of pointerCases) {
  test(`status and query reject ${name} without launching dependencies`, async (t) => {
    const f = await fixture(t);
    await seed(f);
    await writeFile(f.paths.current, contents);
    let launches = 0;
    const graphify = service({ ensureDependencies: async () => { launches += 1; throw new Error("Unexpected setup"); } });
    const status = await graphify.graphStatus(f.options);
    const query = await graphify.queryGraph({ ...f.options, query: "main" });
    assert.equal(status.ok, false);
    assert.equal(status.available, false);
    assert.match(status.error, error);
    assert.equal(query.ok, false);
    assert.match(query.error, error);
    assert.equal(launches, 0);
  });
}

const storageCases = [
  ["pointer directory", async (f) => { await rm(f.paths.current); await mkdir(f.paths.current); }, /pointer.*regular file/i],
  ["pointer symlink", async (f) => {
    const target = path.join(f.root, "pointer.json");
    await writeFile(target, '{"generation":"boundary-snapshot"}');
    await rm(f.paths.current);
    await symlink(target, f.paths.current);
  }, /pointer.*regular file/i],
  ["missing generation", async (_f, active) => { await rm(active.directory, { recursive: true }); }, /generation.*invalid/i],
  ["generation symlink", async (f, active) => {
    await rm(active.directory, { recursive: true });
    await symlink(f.workspace, active.directory);
  }, /generation.*non-symlink directory/i],
  ["graph directory", async (_f, active) => { await rm(active.graph); await mkdir(active.graph); }, /graph.*regular file/i],
  ["graph symlink", async (f, active) => {
    const target = path.join(f.root, "external.json");
    await writeFile(target, JSON.stringify(validGraph));
    await rm(active.graph);
    await symlink(target, active.graph);
  }, /graph.*regular file/i],
  ["oversized graph", async (_f, active) => { await truncate(active.graph, 512 * 1024 * 1024 + 1); }, /graph.*safety limit/i],
  ["malformed graph JSON", async (_f, active) => { await writeFile(active.graph, "{"); }, /graph.*invalid/i],
  ["missing metadata", async (_f, active) => { await rm(active.snapshot); }, /metadata.*invalid/i],
  ["malformed metadata", async (_f, active) => { await writeFile(active.snapshot, "{"); }, /metadata.*invalid/i],
  ["array metadata", async (_f, active) => { await writeFile(active.snapshot, "[]"); }, /metadata.*generation/i],
  ["mismatched metadata", async (_f, active) => { await writeFile(active.snapshot, '{"generation":"other"}'); }, /metadata.*generation/i],
];
for (const [name, corrupt, expected] of storageCases) {
  test(`status rejects ${name}`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    await corrupt(f, active);
    const result = await service().graphStatus(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.match(result.error, expected);
  });
}

test("a missing graph is unavailable and query never attempts setup", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  await rm(active.graph);
  let setup = 0;
  const graphify = service({ ensureDependencies: async () => { setup += 1; throw new Error("Unexpected setup"); } });
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, false);
  const query = await graphify.queryGraph({ ...f.options, query: "main" });
  assert.equal(query.ok, false);
  assert.match(query.error, /no active graph/i);
  assert.equal(setup, 0);
});

const malformedGraphs = [
  ["null graph", null, /nodes array/i],
  ["missing nodes", { edges: [] }, /nodes array/i],
  ["missing edges", { nodes: [] }, /edges or links array/i],
  ["null node", { nodes: [null], edges: [] }, /unique.*ids/i],
  ["numeric node id", { nodes: [{ id: 1, source_file: "main.py" }], edges: [] }, /unique.*ids/i],
  ["empty node id", { nodes: [{ id: "", source_file: "main.py" }], edges: [] }, /unique.*ids/i],
  ["duplicate node ids", { nodes: [validGraph.nodes[0], validGraph.nodes[0]], edges: [] }, /unique.*ids/i],
  ["missing source", { nodes: [{ id: "main" }], edges: [] }, /source_file.*non-empty/i],
  ["untyped external node", { nodes: [{ ...externalNode, type: "code" }], edges: [] }, /source_file.*non-empty/i],
  ["external node without concept type", { nodes: [{ ...externalNode, file_type: "code" }], edges: [] }, /source_file.*non-empty/i],
  ["non-boolean external marker", { nodes: [{ ...externalNode, external: "true" }], edges: [] }, /source_file.*non-empty/i],
  ["external node missing source field", { nodes: [{ ...externalNode, source_file: undefined }], edges: [] }, /source_file.*non-empty/i],
  ["external node escaping workspace", { nodes: [{ ...externalNode, source_file: "../outside.py" }], edges: [] }, /escapes the workspace/i],
  ["external node with credential source", { nodes: [{ ...externalNode, source_file: ".env" }], edges: [] }, /credential-shaped/i],
  ["null edge", { ...validGraph, edges: [null] }, /edges.*reference/i],
  ["missing relation", { ...validGraph, edges: [{ source: "main", target: "main" }] }, /edges.*relation/i],
];
for (const [name, contents, expected] of malformedGraphs) {
  test(`build rejects ${name} and preserves the prior snapshot`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });
    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
    assert.equal((await graphify.graphStatus(f.options)).available, true);
  });
}

test("no extraction output is a failed build, not a new snapshot", async (t) => {
  const f = await fixture(t);
  const graphify = service({ runProcess: async () => ({ stdout: "", stderr: "" }) });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not produce a graph/i);
  assert.deepEqual(await readdir(f.paths.generations), []);
  assert.equal((await graphify.graphStatus(f.options)).available, false);
});

test("empty extraction with links activates a valid zero-source snapshot", async (t) => {
  const f = await fixture(t);
  const graphify = service({ runProcess: async (_file, args) => extract(args, { nodes: [], links: [] }) });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true);
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true);
  assert.deepEqual([status.snapshot.nodes, status.snapshot.edges, status.snapshot.sources], [0, 0, 0]);
  assert.deepEqual(JSON.parse(await readFile(status.active.graph, "utf8")), { nodes: [], links: [] });
});

test("external imports survive publication without being counted as local sources", async (t) => {
  const f = await fixture(t);
  const contents = {
    nodes: [...validGraph.nodes, externalNode],
    edges: [{ source: "main", target: "os", relation: "imports" }],
  };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true);
  assert.deepEqual([status.snapshot.nodes, status.snapshot.edges, status.snapshot.sources], [2, 1, 1]);
  assert.deepEqual(JSON.parse(await readFile(status.active.graph, "utf8")), contents);
});

test("unresolved AST references remain in the graph without a local source", async (t) => {
  const f = await fixture(t);
  const reference = { id: "Path", label: "Path", file_type: "code", source_file: "", source_location: "", _origin: "ast" };
  const contents = { nodes: [...validGraph.nodes, reference], edges: [{ source: "main", target: "Path", relation: "references" }] };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.snapshot.sources, 1);
  assert.deepEqual(JSON.parse(await readFile(result.active.graph, "utf8")), contents);
});

test("failed dependency status does not conceal a readable snapshot or trigger setup", async (t) => {
  const f = await fixture(t);
  await seed(f);
  let setup = 0;
  const graphify = service({
    dependencyStatus: async () => { throw new Error("Offline dependency metadata"); },
    ensureDependencies: async () => { setup += 1; throw new Error("Unexpected setup"); },
  });
  const result = await graphify.graphStatus(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.dependency.state, "unknown");
  assert.match(result.dependency.reason, /Offline dependency metadata/);
  assert.equal(setup, 0);
});

test("pre-aborted build and query do not install dependencies or replace the snapshot", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  let setup = 0;
  const graphify = service({ ensureDependencies: async () => { setup += 1; throw new Error("Unexpected setup"); } });
  const signal = AbortSignal.abort();
  const build = await graphify.buildGraph({ ...f.options, signal });
  const query = await graphify.queryGraph({ ...f.options, query: "main", signal });
  for (const result of [build, query]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /cancelled/i);
  }
  assert.equal(setup, 0);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
});

test("query enforces its upper input boundary before dependency setup", async (t) => {
  const f = await fixture(t);
  await seed(f);
  let setup = 0;
  const graphify = service({ ensureDependencies: async () => { setup += 1; throw new Error("Dependency unavailable"); } });
  const tooLong = await graphify.queryGraph({ ...f.options, query: "x".repeat(4097) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /exceeds 4096/i);
  assert.equal(setup, 0);
  const atLimit = await graphify.queryGraph({ ...f.options, query: "x".repeat(4096) });
  assert.equal(atLimit.ok, false);
  assert.match(atLimit.error, /Dependency unavailable/);
  assert.equal(setup, 1);
});

const invalidPaths = [
  ["missing cwd", (f) => ({ agentDir: f.agentDir }), /workspace cwd.*required/i],
  ["numeric cwd", (f) => ({ cwd: 42, agentDir: f.agentDir }), /workspace cwd.*required/i],
  ["empty profile", (f) => ({ cwd: f.workspace, agentDir: "" }), /profile directory.*required/i],
  ["null profile", (f) => ({ cwd: f.workspace, agentDir: null }), /profile directory.*required/i],
  ["missing workspace", (f) => ({ ...f.options, cwd: path.join(f.root, "missing") }), /cannot resolve/i],
  ["file profile", (f) => ({ cwd: f.workspace, agentDir: path.join(f.workspace, "main.py") }), /profile.*directory/i],
];
for (const [name, options, expected] of invalidPaths) {
  test(`invalid ${name} is rejected without creating managed state`, async (t) => {
    const f = await fixture(t);
    const result = await service().buildGraph(options(f));
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.deepEqual(await readdir(f.agentDir), []);
  });
}

for (const ancestor of ["useful-skills", "memory", "workspace", "generations", "runtime"]) {
  test(`managed ${ancestor} symlink cannot redirect a build`, async (t) => {
    const f = await fixture(t);
    const targets = {
      "useful-skills": path.join(f.agentDir, "useful-skills"),
      memory: path.dirname(f.paths.directory),
      workspace: f.paths.directory,
      generations: f.paths.generations,
      runtime: f.paths.runtime,
    };
    const redirected = path.join(f.root, "redirected");
    await mkdir(redirected);
    await mkdir(path.dirname(targets[ancestor]), { recursive: true });
    await symlink(redirected, targets[ancestor]);
    await assert.rejects(service().graphStatus(f.options), /non-symlink directory/i);
    const result = await service().buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /non-symlink directory/i);
    assert.deepEqual(await readdir(redirected), []);
  });
}

test("failed rebuild after source deletion leaves the previous snapshot queryable", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  await rm(path.join(f.workspace, "main.py"));
  const graphify = service({
    runProcess: async (_file, args) => {
      if (args[3] === "extract") throw new Error("Extractor unavailable");
      const snapshot = JSON.parse(await readFile(args[args.indexOf("--graph") + 1], "utf8"));
      return { stdout: snapshot.nodes.map((node) => node.id).join("\n"), stderr: "" };
    },
  });
  const failed = await graphify.buildGraph(f.options);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Extractor unavailable/);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true, "Snapshot availability must not depend on live source existence");
  const query = await graphify.queryGraph({ ...f.options, query: "main" });
  assert.equal(query.ok, true);
  assert.equal(query.active.generation, active.generation);
  assert.equal(query.output, "main");
});

const rejectedSources = [
  ["credential filename", ".env.py", /credential-shaped/i],
  ["credential directory", ".ssh/config.py", /credential-shaped/i],
  ["generated filename", "schema.generated.py", /generated output/i],
  ["escaping path", "../external.py", /escapes the workspace/i],
  ["source directory", "source-folder", /not a regular file/i],
  ["missing source file", "missing.py", /cannot verify.*source file/i],
  ["outside-root symlink ancestor", "linked/external.py", /outside the workspace/i],
];
for (const [name, source, expected] of rejectedSources) {
  test(`extracted ${name} cannot replace the active graph`, async (t) => {
    const f = await fixture(t);
    await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    if (name === "outside-root symlink ancestor") {
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "external.py"), "def external(): pass\n");
      await symlink(outside, path.join(f.workspace, "linked"));
    } else if (name === "source directory") {
      await mkdir(path.join(f.workspace, source));
    } else if (name !== "missing source file") {
      const file = path.resolve(f.workspace, source);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "def excluded(): pass\n");
    }
    const graphify = service({
      runProcess: async (_file, args) => extract(args, {
        nodes: [...validGraph.nodes, { id: "excluded", source_file: source }],
        edges: [{ source: "main", target: "excluded", relation: "calls" }],
      }),
    });
    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    const status = await graphify.graphStatus(f.options);
    assert.equal(status.available, true);
    assert.deepEqual(JSON.parse(await readFile(status.active.graph, "utf8")), validGraph);
  });
}

test("failed metadata publication leaves the previous graph and metadata active", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await Promise.all([f.paths.current, active.graph, active.snapshot].map((file) => readFile(file, "utf8")));
  const graphify = service({
    runProcess: async (_file, args) => {
      await mkdir(path.join(args.at(-1), "snapshot.json"));
      return extract(args, { nodes: [], edges: [] });
    },
  });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /EISDIR|EPERM|EEXIST|ENOTEMPTY/);
  assert.deepEqual(
    await Promise.all([f.paths.current, active.graph, active.snapshot].map((file) => readFile(file, "utf8"))),
    before,
  );
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true);
  assert.equal(status.active.generation, active.generation);
});

test("cancellation after extraction preserves the active snapshot and removes the unpublished generation", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await Promise.all([f.paths.current, active.graph, active.snapshot].map((file) => readFile(file, "utf8")));
  const controller = new AbortController();
  const graphify = service({
    runProcess: async (_file, args) => {
      const result = await extract(args, validGraph);
      controller.abort();
      return result;
    },
  });

  const result = await graphify.buildGraph({ ...f.options, signal: controller.signal });

  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/i);
  assert.deepEqual(
    await Promise.all([f.paths.current, active.graph, active.snapshot].map((file) => readFile(file, "utf8"))),
    before,
  );
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  assert.equal((await graphify.graphStatus(f.options)).active.generation, active.generation);
});

test("workspace path must be a directory, not a regular source file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    workspaceMemoryPaths({ cwd: path.join(f.workspace, "main.py"), agentDir: f.agentDir }),
    /workspace.*directory/i,
  );
  assert.deepEqual(await readdir(f.agentDir), []);
});
