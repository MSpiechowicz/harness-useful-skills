import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { workspaceMemoryPaths } from "../graphify.js";
import { fixture, seed, service, validGraph } from "./helpers/graph-fixture.js";

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
    const graphify = service({
      ensureDependencies: async () => {
        launches += 1;
        throw new Error("Unexpected setup");
      },
    });
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
  ["pointer directory", async (f) => {
    await rm(f.paths.current);
    await mkdir(f.paths.current);
  }, /pointer.*regular file/i],
  ["pointer symlink", async (f) => {
    const target = path.join(f.root, "pointer.json");
    await writeFile(target, '{"generation":"boundary-snapshot"}');
    await rm(f.paths.current);
    await symlink(target, f.paths.current);
  }, /pointer.*regular file/i],
  ["missing generation", async (_f, active) => {
    await rm(active.directory, { recursive: true });
  }, /generation.*invalid/i],
  ["generation symlink", async (f, active) => {
    await rm(active.directory, { recursive: true });
    await symlink(f.workspace, active.directory);
  }, /generation.*non-symlink directory/i],
  ["graph directory", async (_f, active) => {
    await rm(active.graph);
    await mkdir(active.graph);
  }, /graph.*regular file/i],
  ["graph symlink", async (f, active) => {
    const target = path.join(f.root, "external.json");
    await writeFile(target, JSON.stringify(validGraph));
    await rm(active.graph);
    await symlink(target, active.graph);
  }, /graph.*regular file/i],
  ["oversized graph", async (_f, active) => {
    await truncate(active.graph, 512 * 1024 * 1024 + 1);
  }, /graph.*safety limit/i],
  ["malformed graph JSON", async (_f, active) => {
    await writeFile(active.graph, "{");
  }, /graph.*invalid/i],
  ["missing metadata", async (_f, active) => {
    await rm(active.snapshot);
  }, /metadata.*invalid/i],
  ["malformed metadata", async (_f, active) => {
    await writeFile(active.snapshot, "{");
  }, /metadata.*invalid/i],
  ["array metadata", async (_f, active) => {
    await writeFile(active.snapshot, "[]");
  }, /metadata.*generation/i],
  ["mismatched metadata", async (_f, active) => {
    await writeFile(active.snapshot, '{"generation":"other"}');
  }, /metadata.*generation/i],
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
  const graphify = service({
    ensureDependencies: async () => {
      setup += 1;
      throw new Error("Unexpected setup");
    },
  });
  const status = await graphify.graphStatus(f.options);
  assert.equal(status.available, false);
  const query = await graphify.queryGraph({ ...f.options, query: "main" });
  assert.equal(query.ok, false);
  assert.match(query.error, /no active graph/i);
  assert.equal(setup, 0);
});

test("failed dependency status does not conceal a readable snapshot or trigger setup", async (t) => {
  const f = await fixture(t);
  await seed(f);
  let setup = 0;
  const graphify = service({
    dependencyStatus: async () => {
      throw new Error("Offline dependency metadata");
    },
    ensureDependencies: async () => {
      setup += 1;
      throw new Error("Unexpected setup");
    },
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
  const graphify = service({
    ensureDependencies: async () => {
      setup += 1;
      throw new Error("Unexpected setup");
    },
  });
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
  const graphify = service({
    ensureDependencies: async () => {
      setup += 1;
      throw new Error("Dependency unavailable");
    },
  });
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

test("workspace path must be a directory, not a regular source file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    workspaceMemoryPaths({ cwd: path.join(f.workspace, "main.py"), agentDir: f.agentDir }),
    /workspace.*directory/i,
  );
  assert.deepEqual(await readdir(f.agentDir), []);
});
