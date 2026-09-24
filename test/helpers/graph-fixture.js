import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createGraphify, workspaceMemoryPaths } from "../../graphify.js";

export const validGraph = { nodes: [{ id: "main", source_file: "main.py" }], edges: [] };
export const externalNode = { id: "os", label: "os", file_type: "concept", type: "external", external: true, source_file: "" };

export async function fixture(t) {
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

export async function seed(f, contents = validGraph) {
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

export function service(overrides = {}) {
  return createGraphify({
    dependencyStatus: async () => ({ ready: true, state: "ready" }),
    ensureDependencies: async () => ({ python: "/managed/python", version: "0.9.65" }),
    runProcess: async () => { throw new Error("Unexpected process invocation"); },
    ...overrides,
  });
}

export async function extract(args, contents) {
  const directory = path.join(args.at(-1), "graphify-out");
  await mkdir(directory);
  await writeFile(path.join(directory, "graph.json"), JSON.stringify(contents));
  return { stdout: "", stderr: "" };
}
