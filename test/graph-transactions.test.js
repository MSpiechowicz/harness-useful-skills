import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { extract, fixture, seed, service, validGraph } from "./helpers/graph-fixture.js";

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

test("failed rebuild after source deletion leaves the previous snapshot queryable", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  await rm(path.join(f.workspace, "main.py"));
  const graphify = service({
    runProcess: async (_file, args) => {
      if (args[3] === "extract") {
        throw new Error("Extractor unavailable");
      }

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
