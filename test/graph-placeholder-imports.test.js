import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { dropGeneratedImportTargets, dropSveltePackageImports, dropUnresolvablePlaceholderImports } from "../graph-placeholder-imports.js";
import { isGeneratedOutput } from "../graph-validation.js";
import { extract, fixture, service } from "./helpers/graph-fixture.js";

// Mirrors test/graph-validation.test.js: a test file that writes a dynamic import inside a template string.
const PLACEHOLDER_SOURCE_TEXT = "await writeFile(path.join(f.workspace, importer.source_file), `export const load = () => import('${HTTPS_IMPORT_URL}');\\n`);\n";

// Node and edge shapes follow Graphify 0.9.65 regex-rescue output for template-string imports.
function fileNode(sourceFile) {
  const id = sourceFile.replace(/\W+/g, "_");
  return {
    id,
    label: sourceFile,
    _origin: "ast",
    community: 0,
    file_type: "code",
    norm_label: sourceFile,
    source_file: sourceFile,
    source_location: "L1",
  };
}

function placeholderNode(specifier, overrides = {}) {
  return {
    id: specifier.replace(/\W+/g, "_").replace(/^_+|_+$/g, "").toLowerCase(),
    label: specifier,
    _origin: "ast",
    community: 0,
    confidence: "EXTRACTED",
    file_type: "code",
    norm_label: specifier.toLowerCase(),
    source_file: specifier,
    ...overrides,
  };
}

function dynamicImport(importer, target, overrides = {}) {
  return {
    source: importer.id,
    target: target.id,
    relation: "dynamic_import",
    _origin: "ast",
    confidence: "EXTRACTED",
    confidence_score: 1.0,
    source_file: importer.source_file,
    ...overrides,
  };
}

function graphifyGraph(nodes, links) {
  return { directed: false, multigraph: false, graph: {}, nodes, links, hyperedges: [] };
}

function buildService(contents) {
  return service({
    runProcess: async (_file, args) => extract(args, contents),
    inspectDynamicImportWitnesses: async () => ({ ok: true, witnesses: [], inertMatches: [] }),
  });
}

async function writeSources(f, sourceFiles) {
  for (const sourceFile of sourceFiles) {
    await writeFile(path.join(f.workspace, sourceFile), PLACEHOLDER_SOURCE_TEXT);
  }
}

async function publishedGraph(graphify, f) {
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true);
  const text = await readFile(status.active.graph, "utf8");
  return { status, text, graph: JSON.parse(text) };
}

test("a template-string placeholder import does not block publishing the graph", async (t) => {
  const f = await fixture(t);
  const importer = fileNode("placeholder-import.test.js");
  const placeholder = placeholderNode("${HTTPS_IMPORT_URL}");
  await writeSources(f, [importer.source_file]);
  const graphify = buildService(graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]));

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.snapshot.nodes, result.snapshot.edges, result.snapshot.sources], [1, 0, 1]);

  const { status, text, graph } = await publishedGraph(graphify, f);
  assert.deepEqual(graph.nodes, [importer]);
  assert.deepEqual(graph.links, []);
  assert.equal(text.includes("${"), false);
  assert.equal(status.snapshot.graphHash, createHash("sha256").update(text).digest("hex"));
  assert.deepEqual([status.snapshot.nodes, status.snapshot.edges, status.snapshot.sources], [1, 0, 1]);
});

test("a placeholder import shared by two importers is dropped once with all its edges", async (t) => {
  const f = await fixture(t);
  const first = fileNode("a.js");
  const second = fileNode("c.js");
  const firstExport = { ...fileNode("a.js"), id: "a_s", label: "s", norm_label: "s" };
  const placeholder = placeholderNode("${X}");
  await writeSources(f, [first.source_file, second.source_file]);
  const contains = {
    source: first.id,
    target: firstExport.id,
    relation: "contains",
    _origin: "ast",
    confidence: "EXTRACTED",
    confidence_score: 1.0,
    source_file: first.source_file,
    source_location: "L1",
    weight: 1.0,
  };
  const graphify = buildService(graphifyGraph(
    [placeholder, first, firstExport, second],
    [contains, dynamicImport(first, placeholder), dynamicImport(second, placeholder)],
  ));

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.snapshot.nodes, result.snapshot.edges, result.snapshot.sources], [3, 1, 2]);

  const { status, text, graph } = await publishedGraph(graphify, f);
  assert.deepEqual(graph.nodes.map((node) => node.id), [first.id, firstExport.id, second.id]);
  assert.deepEqual(graph.links, [contains]);
  assert.equal(status.snapshot.graphHash, createHash("sha256").update(text).digest("hex"));
});

test("an indexed template placeholder import is dropped", async (t) => {
  const f = await fixture(t);
  const importer = fileNode("b.js");
  const placeholder = placeholderNode("${specifiers[0]}");
  await writeSources(f, [importer.source_file]);
  const graphify = buildService(graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]));

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);

  const { graph } = await publishedGraph(graphify, f);
  assert.deepEqual(graph.nodes.map((node) => node.id), [importer.id]);
  assert.deepEqual(graph.links, []);
});

test("an HTTPS template placeholder import keeps its existing external-import handling", async (t) => {
  const f = await fixture(t);
  const importer = fileNode("c.js");
  const placeholder = placeholderNode("https://h/${x}");
  await writeSources(f, [importer.source_file]);
  const graphify = buildService(graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]));

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);

  const { graph } = await publishedGraph(graphify, f);
  assert.ok(graph.nodes.some((node) => node.id === placeholder.id && node.source_file === placeholder.source_file));
  assert.equal(graph.links.length, 1);
});

const failClosedCases = [
  ["a relative placeholder import", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("./${y}", { source_file: "${y}" });
    return [[placeholder, importer], [dynamicImport(importer, placeholder)]];
  }, /Cannot verify graph node source file \$\{y\}/],
  ["an absolute placeholder import", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("/${y}");
    return [[placeholder, importer], [dynamicImport(importer, placeholder)]];
  }, /escapes the workspace/],
  ["a placeholder node with an outgoing edge", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}");
    return [[placeholder, importer], [
      dynamicImport(importer, placeholder),
      dynamicImport({ ...placeholder, source_file: importer.source_file }, importer),
    ]];
  }, /Cannot verify graph node source file \$\{X\}/],
  ["a placeholder import with a non-dynamic relation", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}");
    return [[placeholder, importer], [dynamicImport(importer, placeholder, { relation: "imports_from" })]];
  }, /Cannot verify graph node source file \$\{X\}/],
  ["a placeholder import from a non-AST edge", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}");
    return [[placeholder, importer], [dynamicImport(importer, placeholder, { _origin: "llm" })]];
  }, /Cannot verify graph node source file \$\{X\}/],
  ["an alias-resolved placeholder import", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}", { source_file: "src/${X}" });
    return [[placeholder, importer], [dynamicImport(importer, placeholder)]];
  }, /Cannot verify graph node source file src\/\$\{X\}/],
  ["a placeholder node with a source location", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}", { source_location: "L1" });
    return [[placeholder, importer], [dynamicImport(importer, placeholder)]];
  }, /Cannot verify graph node source file \$\{X\}/],
];

for (const [name, graph, expected] of failClosedCases) {
  test(`${name} still fails the build closed`, async (t) => {
    const f = await fixture(t);
    await writeSources(f, ["c.js"]);
    const [nodes, links] = graph();
    const graphify = buildService(graphifyGraph(nodes, links));

    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal((await graphify.graphStatus(f.options)).available, false);
  });
}

const retainedCases = [
  ["a malformed graph", () => ({ nodes: [{ id: "x" }], links: [{ source: "x", target: "missing", relation: "dynamic_import" }] })],
  ["a placeholder without importers", () => graphifyGraph([placeholderNode("${X}")], [])],
  ["a backslash placeholder", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("\\${X}");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]);
  }],
  ["a drive-letter placeholder", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("C:${X}");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]);
  }],
  ["a non-placeholder bare import", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("lodash");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]);
  }],
  ["a located edge", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder, { source_location: "L1" })]);
  }],
  ["an importer with a mismatched edge source file", () => {
    const importer = fileNode("c.js");
    const placeholder = placeholderNode("${X}");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder, { source_file: "other.js" })]);
  }],
  ["a non-AST importer", () => {
    const importer = { ...fileNode("c.js"), _origin: "llm" };
    const placeholder = placeholderNode("${X}");
    return graphifyGraph([placeholder, importer], [dynamicImport(importer, placeholder)]);
  }],
  ["one of two importers failing the importer checks", () => {
    const importer = fileNode("c.js");
    const concept = { ...fileNode("notes.md"), file_type: "document" };
    const placeholder = placeholderNode("${X}");
    return graphifyGraph(
      [placeholder, importer, concept],
      [dynamicImport(importer, placeholder), dynamicImport(concept, placeholder)],
    );
  }],
];

for (const [name, graph] of retainedCases) {
  test(`placeholder pruning leaves ${name} untouched`, () => {
    const contents = graph();
    const before = structuredClone(contents);

    const result = dropUnresolvablePlaceholderImports(contents);
    assert.equal(result.dropped, false);
    assert.equal(result.contents, contents);
    assert.deepEqual(contents, before);
  });
}

test("placeholder pruning keeps every other edge of a very large graph", () => {
  const importer = fileNode("c.js");
  const exported = { ...fileNode("c.js"), id: "c_s", label: "s", norm_label: "s" };
  const placeholder = placeholderNode("${X}");
  const contains = { source: importer.id, target: exported.id, relation: "contains", _origin: "ast", source_file: importer.source_file };
  const links = Array.from({ length: 300_000 }, () => contains);
  links.push(dynamicImport(importer, placeholder));

  const result = dropUnresolvablePlaceholderImports(graphifyGraph([placeholder, importer, exported], links));
  assert.equal(result.dropped, true);
  assert.equal(result.contents.links, links);
  assert.equal(links.length, 300_000);
  assert.equal(links.every((edge) => edge === contains), true);
});

// Graphify 0.9.65 output for `await import("./assets.generated.ts")` when the target is gitignored:
// a stub for the target, a located `imports_from` edge from the function and an unlocated `dynamic_import` from the file.
function generatedStub(specifier, sourceFile, overrides = {}) {
  return placeholderNode(specifier, { id: sourceFile.replace(/\W+/g, "_"), source_file: sourceFile, ...overrides });
}

function generatedImportGraph(specifier, sourceFile, { importerFile = "src/server/http.ts", relation = "imports_from", stub = {} } = {}) {
  const importer = fileNode(importerFile);
  const loader = { ...fileNode(importerFile), id: `${importer.id}_load`, label: "load()", norm_label: "load()", source_location: "L90" };
  const target = generatedStub(specifier, sourceFile, stub);
  const contains = { source: importer.id, target: loader.id, relation: "contains", _origin: "ast", source_file: importerFile, source_location: "L90" };
  return {
    importer, loader, target, contains,
    graph: graphifyGraph([importer, loader, target], [
      contains,
      dynamicImport(loader, target, { relation, source_location: "L92", context: "import", deferred: true }),
      dynamicImport(importer, target),
    ]),
  };
}

async function writeWorkspaceFiles(f, files) {
  for (const file of files) {
    await mkdir(path.dirname(path.join(f.workspace, file)), { recursive: true });
    await writeFile(path.join(f.workspace, file), "export const ASSETS = {};\n");
  }
}

const generatedTargets = [
  ["a gitignored .generated. file", "./assets.generated.ts", "src/server/assets.generated.ts"],
  ["an extensionless .generated. import", "./schema.generated", "src/server/schema.generated.ts"],
  ["a file in a build folder", "../../dist/assets.js", "dist/assets.js"],
];

for (const [name, specifier, sourceFile] of generatedTargets) {
  test(`an import of ${name} does not block publishing the graph`, async (t) => {
    const f = await fixture(t);
    const { importer, loader, contains, graph } = generatedImportGraph(specifier, sourceFile);
    await writeWorkspaceFiles(f, [importer.source_file, sourceFile]);

    const result = await buildService(graph).buildGraph(f.options);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual([result.snapshot.nodes, result.snapshot.edges, result.snapshot.sources], [2, 1, 1]);

    const { graph: published } = await publishedGraph(buildService(graph), f);
    assert.deepEqual(published.nodes, [importer, loader]);
    assert.deepEqual(published.links, [contains]);
  });
}

const generatedFailClosedCases = [
  ["a generated file Graphify read", () => generatedImportGraph("./assets.generated.ts", "src/server/assets.generated.ts", { stub: { source_location: "L1" } }).graph],
  ["a stub that is not the file its specifier names", () => generatedImportGraph("./assets.generated.ts", "src/other/assets.generated.ts").graph],
  ["a stub reached by a non-import relation", () => generatedImportGraph("./assets.generated.ts", "src/server/assets.generated.ts", { relation: "calls" }).graph],
  ["a stub with an outgoing edge", () => {
    const { importer, target, graph } = generatedImportGraph("./assets.generated.ts", "src/server/assets.generated.ts");
    graph.links.push(dynamicImport({ ...target, source_file: target.source_file }, importer));
    return graph;
  }],
  ["a bare specifier", () => generatedImportGraph("assets.generated.ts", "src/server/assets.generated.ts").graph],
  ["a credential-shaped generated file", () => generatedImportGraph("../../dist/.env", "dist/.env").graph],
  ["a key in a build folder", () => generatedImportGraph("../../build/id_rsa", "build/id_rsa").graph],
];

for (const [name, graph] of generatedFailClosedCases) {
  test(`${name} still fails the build`, async (t) => {
    const f = await fixture(t);
    await writeWorkspaceFiles(f, ["src/server/http.ts", "src/server/assets.generated.ts", "src/other/assets.generated.ts"]);

    const result = await buildService(graph()).buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /generated output/);
    assert.equal((await buildService(graph()).graphStatus(f.options)).available, false);
  });
}

test("generated-import pruning leaves an ordinary relative import untouched", () => {
  const { graph } = generatedImportGraph("./assets.ts", "src/server/assets.ts");
  const before = structuredClone(graph);

  const result = dropGeneratedImportTargets(graph, "/workspace");
  assert.equal(result.dropped, false);
  assert.deepEqual(graph, before);
});

test("generated-import pruning leaves a malformed graph untouched", () => {
  const contents = { nodes: [{ id: "x" }], links: [{ source: "x", target: "missing", relation: "imports_from" }] };
  assert.equal(dropGeneratedImportTargets(contents, "/workspace").dropped, false);
});

test("only a workspace path can be generated output", () => {
  assert.equal(isGeneratedOutput("src/a.generated.ts", "/workspace"), true);
  assert.equal(isGeneratedOutput("src/dist/a.ts", "/workspace"), true);
  assert.equal(isGeneratedOutput("src/a.ts", "/workspace"), false);
  assert.equal(isGeneratedOutput("dist/.env", "/workspace"), false);
  assert.equal(isGeneratedOutput("../dist/a.ts", "/workspace"), false);
  assert.equal(isGeneratedOutput("", "/workspace"), false);
  assert.equal(isGeneratedOutput(undefined, "/workspace"), false);
});

// Graphify 0.9.65 output for `import { Tween } from "svelte/motion"` in a component, and the edgeless package stubs it adds.
function svelteImportGraph({ importerFile = "web/src/Kpi.svelte", specifier = "svelte/motion", edge = {}, stub = {} } = {}) {
  const importer = fileNode(importerFile);
  const target = placeholderNode(specifier, stub);
  const orphan = placeholderNode("@lucide/svelte", { id: "lucide_svelte_svelte" });
  const link = { source: importer.id, target: target.id, relation: "imports_from", _origin: "ast", confidence: "EXTRACTED", confidence_score: 1.0, source_file: importerFile, ...edge };
  return { importer, graph: graphifyGraph([importer, target, orphan], [link]) };
}

test("package stubs from a Svelte component do not block publishing the graph", async (t) => {
  const f = await fixture(t);
  const { importer, graph } = svelteImportGraph();
  await writeWorkspaceFiles(f, [importer.source_file]);

  const result = await buildService(graph).buildGraph(f.options);
  assert.equal(result.ok, true, result.error);

  const { graph: published } = await publishedGraph(buildService(graph), f);
  assert.deepEqual(published.nodes, [importer]);
  assert.deepEqual(published.links, []);
});

const svelteKeptCases = [
  ["a TypeScript importer", { importerFile: "web/src/main.ts" }],
  ["a located edge", { edge: { source_location: "L3" } }],
  ["a dynamic import edge", { edge: { relation: "dynamic_import" } }],
  ["a path-like stub", { specifier: "./motion" }],
  ["a stub whose source file differs from its label", { stub: { source_file: "web/src/motion.ts" } }],
  ["a dotfile path", { specifier: "secrets/.env" }],
  ["an escaping path", { specifier: "lib/../../../etc/passwd" }],
  ["a dot-segment dotfile", { specifier: "a/b/../../.env" }],
  ["a credential-shaped name", { specifier: "keys/id_rsa" }],
  ["a generated path", { specifier: "dist/x.js" }],
  ["a name a workspace folder shares", { specifier: "src/lib/util.ts" }],
  ["a scheme", { specifier: "node:fs" }],
];

for (const [name, options] of svelteKeptCases) {
  test(`a package stub reached through ${name} is left for validation`, async (t) => {
    const f = await fixture(t);
    await writeWorkspaceFiles(f, ["src/lib/util.ts"]);
    const { graph } = svelteImportGraph(options);

    dropSveltePackageImports(graph, f.workspace);
    assert.equal(graph.nodes.some((node) => node.label === (options.specifier ?? "svelte/motion")), true);
    assert.equal(graph.links.length, 1);
  });
}

for (const specifier of ["secrets/.env", "dist/x.js", "src/lib/util.ts"]) {
  test(`a Svelte import of ${specifier} still fails the build`, async (t) => {
    const f = await fixture(t);
    const { importer, graph } = svelteImportGraph({ specifier });
    await writeWorkspaceFiles(f, [importer.source_file, "src/lib/util.ts"]);

    const result = await buildService(graph).buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.equal((await buildService(graph).graphStatus(f.options)).available, false);
  });
}

test("an edgeless package stub stays without a Svelte component in the graph", async (t) => {
  const f = await fixture(t);
  const contents = graphifyGraph([fileNode("web/src/main.ts"), placeholderNode("@lucide/svelte")], []);

  assert.equal(dropSveltePackageImports(contents, f.workspace).dropped, false);
  assert.equal(dropSveltePackageImports({}, f.workspace).dropped, false);
  assert.equal(dropSveltePackageImports({ nodes: [null], links: [] }, f.workspace).dropped, false);
});

test("a workspace entry that cannot be checked keeps the package stub", async (t) => {
  const f = await fixture(t);
  const { graph } = svelteImportGraph();
  await writeFile(path.join(f.workspace, "blocker"), "");

  dropSveltePackageImports(graph, path.join(f.workspace, "blocker"));
  assert.equal(graph.nodes.some((node) => node.label === "svelte/motion"), true);
});
