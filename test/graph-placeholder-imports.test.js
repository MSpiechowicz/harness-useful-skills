import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { dropUnresolvablePlaceholderImports } from "../graph-placeholder-imports.js";
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
