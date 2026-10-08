import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { workspaceMemoryPaths } from "../graphify.js";
import { extract, fixture, mountLine, seed, service, validGraph } from "./helpers/graph-fixture.js";

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

/** A build service counting dependency setup and extraction, with an injectable scope and extraction. */
function countedService(scope, runProcess = (args) => extract(args, validGraph)) {
  const calls = { setup: 0, spawn: 0 };
  const graphify = service({
    scope,
    ensureDependencies: async () => {
      calls.setup += 1;
      return { python: "/managed/python", version: "0.9.65" };
    },
    runProcess: async (_file, args) => {
      calls.spawn += 1;
      return runProcess(args);
    },
  });
  return { calls, graphify };
}

/** An overlay mount at `mountPoint` whose lower layer is the filesystem root, which contains every home. */
function homeOverlay(mountPoint) {
  return mountLine(mountPoint, "overlay").replace(/ rw\n$/, " rw,lowerdir=/,upperdir=/srv/u,workdir=/srv/w\n");
}

test("a workspace that is a home directory, contains a mount, or sits on a home-backed mount is refused before storage, setup, or extraction", async (t) => {
  const f = await fixture(t);
  const cases = [
    [{ home: f.workspace }, /Graphify build refused: workspace includes a home directory or is the filesystem root\./],
    [{ system: { readMountInfo: async () => mountLine(path.join(f.paths.workspace, "data")) } }, /refused: workspace contains a nested mount at .*\/workspace\/data\./],
    [{ system: { readMountInfo: async () => homeOverlay(f.paths.workspace) } }, /refused: workspace is on an overlay mount at .*\/workspace whose layers include a home directory\./],
    [{ system: { readMountInfo: async () => homeOverlay(path.dirname(f.paths.workspace)) } }, /refused: workspace is on an overlay mount at .* whose layers include a home directory\./],
    [{ system: { readMountInfo: async () => undefined, platform: "linux" } }, /refused: mount table cannot be checked: \/proc\/self\/mountinfo is missing\./],
    [{ system: { readMountInfo: async () => "not a mount table" } }, /refused: mount table cannot be checked/],
    [{ system: { readMountInfo: async () => "" } }, /refused: mount table does not list the workspace's mount \(for example a masked \/proc or a chroot\)\./],
    [{ system: { readMountInfo: async () => homeOverlay("/") + mountLine(f.paths.workspace) } }, /refused: workspace is on an overlay mount at \/ whose layers include a home directory\./],
  ];

  for (const [scope, expected] of cases) {
    const { calls, graphify } = countedService(scope);
    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.deepEqual(calls, { setup: 0, spawn: 0 });
    assert.deepEqual(await readdir(f.agentDir), []);
  }
});

test("a workspace whose identity changes between pinning and extraction is refused before spawn", async (t) => {
  const f = await fixture(t);
  let swapped = false;
  let spawned = 0;
  const swappingStat = async (file, options) => {
    const details = await stat(file, options);
    return swapped && file === f.paths.workspace ? { dev: details.dev, ino: details.ino + 1n } : details;
  };
  const graphify = service({
    scope: { system: { stat: swappingStat } },
    ensureDependencies: async () => {
      swapped = true;
      return { python: "/managed/python", version: "0.9.65" };
    },
    runProcess: async () => {
      spawned += 1;
      throw new Error("Unexpected extraction");
    },
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /Workspace directory changed during the graph build/);
  assert.equal(spawned, 0);
});

test("a workspace swapped during extraction is refused and the prior generation is kept", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const { calls, graphify } = countedService({}, async (args) => {
    const result = await extract(args, validGraph);
    await rename(f.workspace, `${f.workspace}-old`);
    await mkdir(f.workspace);
    await writeFile(path.join(f.workspace, "main.py"), "def main(): pass\n");
    return result;
  });

  const result = await graphify.buildGraph(f.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /Workspace directory changed during the graph build/);
  assert.equal(calls.spawn, 1);
  assert.equal(await readFile(f.paths.current, "utf8"), before);
});

test("sources on another device or behind a bind-mounted home are refused and the prior generation is kept", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const before = await readFile(f.paths.current, "utf8");
  const home = path.join(f.root, "home");
  await mkdir(home);
  await mkdir(path.join(f.workspace, "sub"));
  await writeFile(path.join(f.workspace, "sub", "mod.py"), "x = 1\n");
  const contents = { nodes: [...validGraph.nodes, { id: "mod", source_file: "sub/mod.py" }], edges: [] };

  const source = path.join(f.paths.workspace, "main.py");
  const otherDevice = async (file, options) => {
    const details = await stat(file, options);
    return file === source ? { dev: details.dev + 1n, ino: details.ino } : details;
  };
  const sub = path.join(f.paths.workspace, "sub");
  const homeMount = (file, options) => stat(file === sub ? home : file, options);

  const cases = [
    [{ system: { stat: otherDevice } }, /main\.py lies on a different device than the workspace .*btrfs subvolume/],
    [{ home, system: { stat: homeMount } }, /sub\/mod\.py passes through a mount of a protected home directory at sub\./],
  ];
  for (const [scope, expected] of cases) {
    const { calls, graphify } = countedService(scope, (args) => extract(args, contents));
    const result = await graphify.buildGraph(f.options);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(calls.spawn, 1);
    assert.equal(await readFile(f.paths.current, "utf8"), before);
  }
});
