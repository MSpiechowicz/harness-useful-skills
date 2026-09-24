import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { externalNode, extract, fixture, seed, service, validGraph } from "./helpers/graph-fixture.js";

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
  ["AST package reference without an import edge", {
    nodes: [...validGraph.nodes, { id: "package_component_d_ts", label: "component.d.ts", file_type: "code", source_file: "@scope/package/component.d.ts", _origin: "ast" }],
    edges: [],
  }, /external.*import/i],
  ["AST package reference with a non-import edge", {
    nodes: [...validGraph.nodes, { id: "package_component_d_ts", label: "component.d.ts", file_type: "code", source_file: "@scope/package/component.d.ts", _origin: "ast" }],
    edges: [{ source: "main", target: "package_component_d_ts", relation: "references" }],
  }, /external.*import/i],
  ["AST package reference with a mismatched importer path", {
    nodes: [
      { id: "main", label: "main", file_type: "code", source_file: "main.py", source_location: "main.py", _origin: "ast" },
      { id: "package_component_d_ts", label: "component.d.ts", file_type: "code", source_file: "@scope/package/component.d.ts", _origin: "ast" },
    ],
    edges: [{ source: "main", target: "package_component_d_ts", relation: "dynamic_import", _origin: "ast", source_file: "other.py" }],
  }, /external.*import/i],
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

test("external AST import references publish with only local sources counted", async (t) => {
  const f = await fixture(t);
  const importer = { id: "main", label: "main", file_type: "code", source_file: "main.py", source_location: "main.py", _origin: "ast" };
  const externalReferences = [
    {
      id: "scoped_package_component_d_ts",
      label: "component.d.ts",
      _origin: "ast",
      file_type: "code",
      source_file: "@scope/package/src/component.d.ts",
    },
    {
      id: "scoped_package_module_js",
      label: "module.js",
      _origin: "ast",
      file_type: "code",
      source_file: "@scope/package/lib/module.js",
    },
    {
      id: "utility_package",
      label: "utility-package",
      _origin: "ast",
      file_type: "code",
      source_file: "utility-package",
    },
    {
      id: "remote_module_js",
      label: "https://example.invalid/remote-module.js",
      _origin: "ast",
      file_type: "code",
      source_file: "https://example.invalid/remote-module.js",
    },
  ];
  const contents = {
    nodes: [importer, ...externalReferences],
    links: externalReferences.map((reference) => ({
      source: importer.id,
      target: reference.id,
      relation: "dynamic_import",
      _origin: "ast",
      source_file: importer.source_file,
    })),
  };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.snapshot.nodes, result.snapshot.edges, result.snapshot.sources], [5, 4, 1]);

  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, true);
  assert.equal(status.active.generation, result.snapshot.generation);
  const publishedGraph = JSON.parse(await readFile(status.active.graph, "utf8"));
  assert.ok(publishedGraph.nodes.some((node) => node.id === importer.id && node.source_file === importer.source_file));
  for (const reference of externalReferences) {
    assert.ok(publishedGraph.nodes.some((node) => node.id === reference.id && node.source_file === reference.source_file));
    assert.ok(publishedGraph.links.some((link) => link.source === importer.id && link.target === reference.id && link.relation === "dynamic_import"));
  }
});

for (const label of ["../App.d.ts", "./App.d.ts"]) {
  test(`missing local AST import labeled ${label} preserves the active snapshot`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const localDirectory = path.join(f.workspace, "src", "shared", "react");
    await mkdir(localDirectory, { recursive: true });
    const importerSource = "src/shared/react/index.ts";
    await writeFile(path.join(localDirectory, "index.ts"), "import App from '../App.d.ts';\n");
    const importer = {
      id: "index_ts",
      label: "index.ts",
      _origin: "ast",
      file_type: "code",
      source_file: importerSource,
      source_location: importerSource,
    };
    const reference = {
      id: "app_d_ts",
      label,
      _origin: "ast",
      file_type: "code",
      source_file: "src/shared/react/App.d.ts",
    };
    const contents = {
      nodes: [importer, reference],
      edges: [{ source: importer.id, target: reference.id, relation: "dynamic_import", _origin: "ast", source_file: importerSource }],
    };
    const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });

    const result = await graphify.buildGraph(f.options);

    assert.equal(result.ok, false);
    assert.match(result.error, /cannot verify.*source file/i);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
    assert.equal((await graphify.graphStatus(f.options)).active.generation, active.generation);
  });
}

test("a missing workspace-rooted AST source cannot be skipped as a package import", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const localDirectory = path.join(f.workspace, "src", "shared", "react");
  await mkdir(localDirectory, { recursive: true });
  const importerSource = "src/shared/react/index.ts";
  await writeFile(path.join(localDirectory, "index.ts"), "import App from '../App.d.ts';\n");
  const importer = {
    id: "index_ts",
    label: "index.ts",
    _origin: "ast",
    file_type: "code",
    source_file: importerSource,
    source_location: importerSource,
  };
  const reference = {
    id: "app_d_ts",
    label: "App.d.ts",
    _origin: "ast",
    file_type: "code",
    source_file: "src/shared/react/App.d.ts",
  };
  const contents = {
    nodes: [importer, reference],
    edges: [{ source: importer.id, target: reference.id, relation: "dynamic_import", _origin: "ast", source_file: importerSource }],
  };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });

  const result = await graphify.buildGraph(f.options);

  assert.equal(result.ok, false);
  assert.match(result.error, /cannot verify.*source file/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  assert.equal((await graphify.graphStatus(f.options)).active.generation, active.generation);
});

for (const [name, sourceFile] of [
  ["missing local relative import", "./missing-local.js"],
  ["missing absolute source", (f) => path.join(f.workspace, "missing-absolute.js")],
]) {
  test(`external AST classification does not skip a ${name}`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const importer = { id: "main", label: "main", file_type: "code", source_file: "main.py", source_location: "main.py", _origin: "ast" };
    const reference = {
      id: "missing-reference",
      label: "missing-reference",
      _origin: "ast",
      file_type: "code",
      source_file: typeof sourceFile === "function" ? sourceFile(f) : sourceFile,
    };
    const contents = {
      nodes: [importer, reference],
      links: [{ source: importer.id, target: reference.id, relation: "dynamic_import", _origin: "ast", source_file: importer.source_file }],
    };
    const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });
    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /cannot verify.*source file/i);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  });
}

test("external AST import cannot hide a missing source behind an outside symlink", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.workspace, "@scope"));
  const importer = { id: "main", label: "main", file_type: "code", source_file: "main.py", source_location: "main.py", _origin: "ast" };
  const reference = {
    id: "package_component_d_ts",
    label: "@scope/package/component.d.ts",
    _origin: "ast",
    file_type: "code",
    source_file: "@scope/package/component.d.ts",
  };
  const contents = {
    nodes: [importer, reference],
    links: [{ source: importer.id, target: reference.id, relation: "dynamic_import", _origin: "ast", source_file: importer.source_file }],
  };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });
  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /outside the workspace/i);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
  assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
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

for (const [kind, target, expected] of [
  ["credential", ".ssh/config.py", /credential-shaped: alias\.py/i],
  ["generated", "generated/schema.py", /generated output: alias\.py/i],
]) {
  test(`a symlink alias to a ${kind} source cannot replace the active graph`, async (t) => {
    const f = await fixture(t);
    const active = await seed(f);
    const before = await readFile(f.paths.current, "utf8");
    const targetPath = path.join(f.workspace, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "def synthetic_private_marker(): return 7\n");
    await symlink(target, path.join(f.workspace, "alias.py"));
    const graphify = service({
      runProcess: async (_file, args) => extract(args, {
        nodes: [...validGraph.nodes, { id: "alias", source_file: "alias.py" }],
        edges: [],
      }),
    });

    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
    assert.deepEqual(await readdir(f.paths.generations), [active.generation]);
  });
}

test("a package-shaped AST import through a credential directory alias is rejected before a missing child", async (t) => {
  const f = await fixture(t);
  const active = await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  await mkdir(path.join(f.workspace, ".ssh"));
  await symlink(".ssh", path.join(f.workspace, "safe-package"));
  const importer = {
    id: "main",
    label: "main",
    file_type: "code",
    source_file: "main.py",
    source_location: "main.py",
    _origin: "ast",
  };
  const reference = {
    id: "reference",
    label: "missing.py",
    file_type: "code",
    source_file: "safe-package/missing.py",
    _origin: "ast",
  };
  const contents = {
    nodes: [importer, reference],
    edges: [{ source: "main", target: "reference", relation: "dynamic_import", _origin: "ast", source_file: "main.py" }],
  };
  const graphify = service({ runProcess: async (_file, args) => extract(args, contents) });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /credential-shaped: safe-package\/missing\.py/i);
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
