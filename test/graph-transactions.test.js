import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { extract, fixture, seed, service, validGraph } from "./helpers/graph-fixture.js";

function localImportGraph(specifiers) {
  const sourceFile = "src/i18n/index.js";
  const importer = {
    id: "i18n_index",
    label: "i18n/index.js",
    _origin: "ast",
    file_type: "code",
    source_file: sourceFile,
    source_location: "L1",
  };
  const references = specifiers.map(({ id, specifier }) => ({
    id,
    label: specifier,
    _origin: "ast",
    file_type: "code",
    source_file: path.posix.join(path.posix.dirname(sourceFile), specifier),
  }));

  return {
    sourceFile,
    importer,
    references,
    contents: {
      nodes: [...validGraph.nodes, importer, ...references],
      links: references.map((reference) => ({
        source: importer.id,
        target: reference.id,
        relation: "dynamic_import",
        _origin: "ast",
        source_file: importer.source_file,
      })),
    },
  };
}

function localJsImporter(sourceFile, id) {
  return {
    id,
    label: path.basename(sourceFile),
    _origin: "ast",
    file_type: "code",
    source_file: sourceFile,
    source_location: "L1",
  };
}

function localhostReference(sourceFile, id = "localhost_module") {
  return {
    id,
    label: sourceFile.slice("http://".length),
    _origin: "ast",
    file_type: "code",
    source_file: sourceFile,
  };
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

test("cancellation during staged import provenance preserves the active snapshot", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await Promise.all([f.paths.current, active.graph, active.snapshot].map((file) => readFile(file, "utf8")));
  const url = "https://example.invalid/remote.js";
  const importer = {
    id: "dynamic_importer",
    label: "main.js",
    _origin: "ast",
    file_type: "code",
    source_file: "main.js",
    source_location: "L1",
  };
  const reference = {
    id: "remote_module_js",
    label: "example.invalid/remote.js",
    _origin: "ast",
    file_type: "code",
    source_file: url,
  };
  await writeFile(path.join(f.workspace, importer.source_file), `import('${url}');\n`);
  const controller = new AbortController();
  const graphify = service({
    runProcess: async (_file, args) => extract(args, { nodes: [importer, reference], links: [] }),
    inspectDynamicImportWitnesses: async () => {
      controller.abort();
      return {
        ok: true,
        witnesses: [{ sourceFile: importer.source_file, url, sourceLocation: "L1" }],
        inertMatches: [],
      };
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

test("staged inert template imports are removed before snapshot publication", async (t) => {
  const f = await fixture(t);
  const specifiers = ["./dict/de-DE.json", "./dict/en-GB.json"];
  const graph = localImportGraph(specifiers.map((specifier, index) => ({ id: `dict_${index}`, specifier })));
  const documentation = `const examples = \`import('${specifiers[0]}') import('${specifiers[1]}')\`;\n`;
  await mkdir(path.dirname(path.join(f.workspace, graph.sourceFile)), { recursive: true });
  await writeFile(path.join(f.workspace, graph.sourceFile), documentation);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const graphify = service({
    runProcess: async (_file, args) => extract(args, graph.contents),
    inspectDynamicImportWitnesses: async () => ({
      ok: true,
      witnesses: [],
      inertMatches: specifiers.map((specifier) => ({ sourceFile: graph.sourceFile, specifier })),
    }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  const status = await graphify.graphStatus(f.options);
  const graphText = await readFile(status.active.graph, "utf8");
  const published = JSON.parse(graphText);
  assert.deepEqual([status.snapshot.nodes, status.snapshot.edges, status.snapshot.sources], [2, 0, 2]);
  assert.equal(published.nodes.some((node) => graph.references.some((reference) => node.id === reference.id)), false);
  assert.deepEqual(published.links, []);
  assert.equal(status.snapshot.graphHash, createHash("sha256").update(graphText).digest("hex"));
  assert.notEqual(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(JSON.parse(await readFile(f.paths.current, "utf8")), { generation: status.active.generation });
  assert.notEqual(status.active.generation, active.generation);
});

test("a mixed inert and executable local import keeps the missing executable target and prior snapshot", async (t) => {
  const f = await fixture(t);
  const inertSpecifier = "./dict/de-DE.json";
  const realSpecifier = "./dict/en-GB.json";
  const graph = localImportGraph([
    { id: "dict_de", specifier: inertSpecifier },
    { id: "dict_en", specifier: realSpecifier },
  ]);
  await mkdir(path.dirname(path.join(f.workspace, graph.sourceFile)), { recursive: true });
  await writeFile(
    path.join(f.workspace, graph.sourceFile),
    `const example = \`import('${inertSpecifier}')\`;\nexport const load = () => import('${realSpecifier}');\n`,
  );
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const graphify = service({
    runProcess: async (_file, args) => extract(args, graph.contents),
    inspectDynamicImportWitnesses: async () => ({
      ok: true,
      witnesses: [{ sourceFile: graph.sourceFile, url: realSpecifier, sourceLocation: "L2" }],
      inertMatches: [{ sourceFile: graph.sourceFile, specifier: inertSpecifier }],
    }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /Cannot verify graph node source file src\/i18n\/dict\/en-GB\.json: ENOENT/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  assert.equal((await graphify.graphStatus(f.options)).active.generation, active.generation);
});

test("an inconclusive parser verdict cannot remove a missing local import", async (t) => {
  const f = await fixture(t);
  const specifier = "./dict/de-DE.json";
  const graph = localImportGraph([{ id: "dict_de", specifier }]);
  await mkdir(path.dirname(path.join(f.workspace, graph.sourceFile)), { recursive: true });
  await writeFile(path.join(f.workspace, graph.sourceFile), `const example = \`import('${specifier}')\`;\n`);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const graphify = service({
    runProcess: async (_file, args) => extract(args, graph.contents),
    inspectDynamicImportWitnesses: async () => ({ ok: false, error: "syntax-error" }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not verify staged import provenance: syntax-error/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
});

for (const [name, mutate] of [
  ["an additional incoming edge", (graph) => graph.contents.links.push({
    source: "main",
    target: graph.references[0].id,
    relation: "references",
  })],
  ["a located incoming edge", (graph) => { graph.contents.links[0].source_location = "L1"; }],
  ["a mismatched resolved target", (graph) => { graph.references[0].source_file = "src/i18n/other/de-DE.json"; }],
]) {
  test(`inert import text cannot remove a local reference with ${name}`, async (t) => {
    const f = await fixture(t);
    const specifier = "./dict/de-DE.json";
    const graph = localImportGraph([{ id: "dict_de", specifier }]);
    mutate(graph);
    await mkdir(path.dirname(path.join(f.workspace, graph.sourceFile)), { recursive: true });
    await writeFile(path.join(f.workspace, graph.sourceFile), `const example = \`import('${specifier}')\`;\n`);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const graphify = service({
      runProcess: async (_file, args) => extract(args, graph.contents),
      inspectDynamicImportWitnesses: async () => ({
        ok: true,
        witnesses: [],
        inertMatches: [{ sourceFile: graph.sourceFile, specifier }],
      }),
    });

    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /cannot verify.*source file/i);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  });
}

test("an inert local import cannot remove a reference through a target symlink", async (t) => {
  const f = await fixture(t);
  const specifier = "./dict/de-DE.json";
  const graph = localImportGraph([{ id: "dict_de", specifier }]);
  await mkdir(path.dirname(path.join(f.workspace, graph.sourceFile)), { recursive: true });
  await writeFile(path.join(f.workspace, graph.sourceFile), `const example = \`import('${specifier}')\`;\n`);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.workspace, "src/i18n/dict"));
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const graphify = service({
    runProcess: async (_file, args) => extract(args, graph.contents),
    inspectDynamicImportWitnesses: async () => ({
      ok: true,
      witnesses: [],
      inertMatches: [{ sourceFile: graph.sourceFile, specifier }],
    }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot verify.*source file/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
});

test("a witnessed localhost HTTP dynamic import publishes as an external relationship", async (t) => {
  const f = await fixture(t);
  const url = "http://localhost:3000/web/elements/EBWebFeedbackCTA.js";
  const importer = { ...localJsImporter("src/feedback.js", "feedback_importer"), label: "src/feedback.js" };
  const reference = localhostReference(url);
  const contents = { nodes: [...validGraph.nodes, importer, reference], links: [] };
  await mkdir(path.dirname(path.join(f.workspace, importer.source_file)), { recursive: true });
  await writeFile(path.join(f.workspace, importer.source_file), `export const load = () => import('${url}');\n`);
  const graphify = service({
    runProcess: async (_file, args) => extract(args, contents),
    inspectDynamicImportWitnesses: async () => ({
      ok: true,
      witnesses: [{ sourceFile: importer.source_file, url, sourceLocation: "L1" }],
      inertMatches: [],
    }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  const graphText = await readFile(result.active.graph, "utf8");
  const published = JSON.parse(graphText);
  assert.deepEqual([result.snapshot.nodes, result.snapshot.edges, result.snapshot.sources], [3, 1, 2]);
  assert.deepEqual(published.links, [{
    source: importer.id,
    target: reference.id,
    relation: "dynamic_import",
    _origin: "ast",
    source_file: importer.source_file,
    source_location: "L1",
  }]);
  assert.equal(result.snapshot.graphHash, createHash("sha256").update(graphText).digest("hex"));
});

for (const url of [
  "http://example.invalid/web.js",
  "http://127.0.0.1/web.js",
  "http://localhost.evil/web.js",
  "http://user@localhost/web.js",
  "http://localhost:3000/web.js?mode=dev",
  "http://localhost:3000/web.js#fragment",
  "http://localhost:3000/../outside.js",
  "http://localhost:3000/%2e%2e/outside.js",
  "http://LOCALHOST:3000/web.js",
]) {
  test(`unsafe HTTP import ${url} cannot replace the active snapshot`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const contents = { nodes: [...validGraph.nodes, localhostReference(url)], links: [] };
    const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });

    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /safe literal http:\/\/localhost URL/i);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  });
}

test("localhost HTTP references without one exact parser witness preserve the active snapshot", async (t) => {
  const f = await fixture(t);
  const url = "http://localhost:3000/web/elements/EBWebFeedbackCTA.js";
  const importer = { ...localJsImporter("src/feedback.js", "feedback_importer"), label: "src/feedback.js" };
  const reference = localhostReference(url);
  const contents = { nodes: [...validGraph.nodes, importer, reference], links: [] };
  await mkdir(path.dirname(path.join(f.workspace, importer.source_file)), { recursive: true });
  await writeFile(path.join(f.workspace, importer.source_file), `export const load = () => import('${url}');\n`);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const graphify = service({
    runProcess: async (_file, args) => extract(args, contents),
    inspectDynamicImportWitnesses: async () => ({ ok: true, witnesses: [], inertMatches: [] }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /localhost HTTP imports require one exact dynamic-import witness/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
});

test("a symlink alias to an allowed source inside the workspace can be published", async (t) => {
  const f = await fixture(t);
  await symlink("main.py", path.join(f.workspace, "alias.py"));
  const graphify = service({
    runProcess: async (_file, args) => extract(args, {
      nodes: [...validGraph.nodes, { id: "alias", source_file: "alias.py" }],
      edges: [],
    }),
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.snapshot.sources, 2);
});
