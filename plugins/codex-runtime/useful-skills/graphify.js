import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { dependencyStatus, ensureDependencies } from "./dependencies.js";
import { errorMessage, truncateUtf8 } from "./graph-safety.js";
import { activeSnapshot, checkExistingManagedPath, existingDirectory, MAX_GRAPH_BYTES, prepareRuntime, prepareStorage, PRIVATE_MODE, stagedGraphContents, writeAtomic } from "./graph-storage.js";
import { graphValidationError, importRelations, isExternalImportReference, isSourceLessReference, validateExternalImportSource, validateSource } from "./graph-validation.js";
import { inspectDynamicImportWitnesses, repairMissingExternalImportEdges } from "./graph-import-provenance.js";
import { dropGeneratedImportTargets, dropSveltePackageImports, dropUnresolvablePlaceholderImports } from "./graph-placeholder-imports.js";
import { assertWorkspaceUnchanged, pinWorkspace, scopeSystem, sourceScopeError, workspaceMountBlocker, workspaceScopeBlocker } from "./graph-scope.js";
import { isPathWithin } from "./path-boundary.js";
import { runProcess } from "./process.js";

const BUILD_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_QUERY_CHARS = 4_096;
const MAX_QUERY_OUTPUT_BYTES = 8 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

function createBuildDeadline(signal) {
  const timeoutError = new Error(`Graphify build timed out after ${BUILD_TIMEOUT_MS}ms.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError), BUILD_TIMEOUT_MS);
  timer.unref?.();

  return Object.freeze({
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timeoutError,
    dispose: () => clearTimeout(timer),
  });
}

function assertBuildActive(deadline) {
  if (!deadline.signal.aborted) {
    return;
  }

  if (deadline.signal.reason === deadline.timeoutError) {
    throw deadline.timeoutError;
  }

  throw new Error("Graphify build was cancelled.");
}

/** Refuse home-covering, root, or mount-crossing workspaces before any storage, setup, or extraction. */
async function pinBuildScope(workspace, scope) {
  const scopeReason = await workspaceScopeBlocker([workspace], scope);
  if (scopeReason) {
    throw new Error(`Graphify build refused: ${scopeReason}.`);
  }

  const mountReason = await workspaceMountBlocker(workspace, scope);
  if (mountReason) {
    throw new Error(`Graphify build refused: ${mountReason}.`);
  }

  return pinWorkspace(workspace, scope);
}

/** Device and bind-mount checks for one graph source; missing optional sources have nothing to read. */
async function sourceScopeCheck(sourceFile, pin, scope, { missingAllowed = false } = {}) {
  let resolved;

  try {
    resolved = await realpath(path.resolve(pin.realpath, sourceFile));
  } catch (error) {
    if (missingAllowed && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) {
      return undefined;
    }

    return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
  }

  return sourceScopeError(resolved, pin, scope);
}

export async function workspaceMemoryPaths({ cwd, agentDir }) {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("A workspace cwd is required.");
  }

  if (typeof agentDir !== "string" || !agentDir) {
    throw new Error("An agent profile directory is required.");
  }
  let workspace;
  let profile;

  try {
    workspace = await realpath(cwd);
    profile = await realpath(agentDir);
  } catch (error) {
    throw new Error(`Cannot resolve workspace or agent profile: ${errorMessage(error)}`);
  }
  if (path.resolve(agentDir) !== profile) {
    throw new Error("Agent profile paths must not contain symbolic links.");
  }

  await existingDirectory(workspace, "Workspace directory");
  await existingDirectory(profile, "Agent profile directory");

  const workspaceHash = createHash("sha256").update(workspace).digest("hex");
  const directory = path.join(profile, "useful-skills", "memory", workspaceHash);
  if (isPathWithin(workspace, directory)) {
    throw new Error("Managed memory storage must be outside the workspace.");
  }

  const paths = Object.freeze({
    workspace,
    workspaceHash,
    agentDir: profile,
    directory,
    generations: path.join(directory, "generations"),
    runtime: path.join(directory, "runtime"),
    current: path.join(directory, "current.json"),
    notes: path.join(directory, "notes.md"),
    graph: undefined,
    snapshot: undefined,
  });

  await checkExistingManagedPath(paths);
  return paths;
}

export function createGraphify(overrides = {}) {
  const runtime = Object.freeze({
    dependencyStatus: overrides.dependencyStatus ?? dependencyStatus,
    ensureDependencies: overrides.ensureDependencies ?? ensureDependencies,
    runProcess: overrides.runProcess ?? runProcess,
    inspectDynamicImportWitnesses: overrides.inspectDynamicImportWitnesses ?? inspectDynamicImportWitnesses,
  });
  const scope = Object.freeze({ home: overrides.scope?.home, system: scopeSystem(overrides.scope?.system) });

  async function graphStatusFor({ cwd, agentDir }) {
    const paths = await workspaceMemoryPaths({ cwd, agentDir });
    const graph = await activeSnapshot(paths);
    let dependency;

    try {
      dependency = await runtime.dependencyStatus({ agentDir });
    } catch (error) {
      dependency = { state: "unknown", reason: errorMessage(error) };
    }

    return {
      ok: !graph.error,
      backend: "graphify",
      available: graph.available,
      paths,
      dependency,
      ...(graph.available ? { snapshot: graph.metadata, active: graph.active } : {}),
      ...(graph.error ? { error: graph.error } : {}),
    };
  }

  async function buildGraphFor({ cwd, agentDir, signal } = {}) {
    let paths;
    let staging;
    let unpublishedGeneration;
    let deadline;

    try {
      paths = await workspaceMemoryPaths({ cwd, agentDir });

      if (signal?.aborted) {
        throw new Error("Graphify build was cancelled.");
      }

      const pin = await pinBuildScope(paths.workspace, scope);

      await prepareStorage(paths);
      const dependencies = await runtime.ensureDependencies({ agentDir, signal });
      deadline = createBuildDeadline(signal);
      assertBuildActive(deadline);

      const environment = await prepareRuntime(paths, dependencies.python);
      assertBuildActive(deadline);

      const generation = randomUUID();
      staging = path.join(paths.generations, `.staging-${generation}`);
      await mkdir(staging, { mode: PRIVATE_MODE });
      await assertWorkspaceUnchanged(pin, scope);
      assertBuildActive(deadline);

      const result = await runtime.runProcess(
        dependencies.python,
        ["-I", "-m", "graphify", "extract", paths.workspace, "--code-only", "--no-dedup", "--max-workers", "2", "--out", staging],
        {
          cwd: paths.directory,
          env: { ...environment.environment, GRAPHIFY_OUT: "graphify-out", GRAPHIFY_QUERY_LOG_DISABLE: "1", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1" },
          timeoutMs: BUILD_TIMEOUT_MS,
          signal: deadline.signal,
          maxBytes: MAX_PROCESS_OUTPUT_BYTES,
        },
      ).catch((error) => {
        assertBuildActive(deadline);
        throw error;
      });
      assertBuildActive(deadline);
      await assertWorkspaceUnchanged(pin, scope);

      const stagedGraph = await stagedGraphContents(path.join(staging, "graphify-out", "graph.json"));
      assertBuildActive(deadline);

      if (!stagedGraph.available) {
        throw new Error(stagedGraph.error ?? "Graphify did not produce a graph.");
      }

      const placeholderImports = dropUnresolvablePlaceholderImports(stagedGraph.contents);
      const generatedImports = dropGeneratedImportTargets(stagedGraph.contents, paths.workspace);
      const svelteImports = dropSveltePackageImports(stagedGraph.contents, paths.workspace);

      const repairedStagedImports = await repairMissingExternalImportEdges({
        contents: stagedGraph.contents,
        workspace: paths.workspace,
        python: dependencies.python,
        environment,
        runProcess: runtime.runProcess,
        staging,
        signal: deadline.signal,
        assertActive: () => assertBuildActive(deadline),
        inspectWitnesses: runtime.inspectDynamicImportWitnesses,
      }).catch((error) => {
        assertBuildActive(deadline);
        throw error;
      });
      assertBuildActive(deadline);

      const graphError = graphValidationError(stagedGraph.contents, paths.workspace);
      if (graphError) {
        throw new Error(graphError);
      }

      const rewrittenStagedGraph = placeholderImports.dropped || generatedImports.dropped || svelteImports.dropped || repairedStagedImports;
      const graphText = rewrittenStagedGraph ? JSON.stringify(stagedGraph.contents) : stagedGraph.text;
      if (Buffer.byteLength(graphText) > MAX_GRAPH_BYTES) {
        throw new Error("Staged graph exceeds the 512 MiB safety limit.");
      }
      const graphHash = createHash("sha256").update(graphText).digest("hex");
      const sourceFiles = new Set();
      const externalSources = new Set();
      const edges = stagedGraph.contents.edges ?? stagedGraph.contents.links;
      const relations = importRelations(edges);
      const nodesById = new Map(stagedGraph.contents.nodes.map((node) => [node.id, node]));

      for (const node of stagedGraph.contents.nodes) {
        if (isSourceLessReference(node)) {
          continue;
        }

        if (isExternalImportReference(node, nodesById, relations)) {
          externalSources.add(node.source_file);
        } else {
          sourceFiles.add(node.source_file);
        }
      }

      for (const sourceFile of sourceFiles) {
        assertBuildActive(deadline);
        const sourceError = await validateSource(sourceFile, paths.workspace)
          ?? await sourceScopeCheck(sourceFile, pin, scope);
        assertBuildActive(deadline);

        if (sourceError) {
          throw new Error(sourceError);
        }
      }

      for (const sourceFile of externalSources) {
        assertBuildActive(deadline);
        const sourceError = await validateExternalImportSource(sourceFile, paths.workspace)
          ?? await sourceScopeCheck(sourceFile, pin, scope, { missingAllowed: true });
        assertBuildActive(deadline);

        if (sourceError) {
          throw new Error(sourceError);
        }
      }

      const metadata = {
        generation,
        builtAt: new Date().toISOString(),
        package: "graphifyy",
        version: dependencies.version,
        workspace: paths.workspace,
        workspaceHash: paths.workspaceHash,
        graphHash,
        nodes: stagedGraph.contents.nodes.length,
        edges: (stagedGraph.contents.edges ?? stagedGraph.contents.links).length,
        sources: sourceFiles.size,
      };
      assertBuildActive(deadline);
      await writeAtomic(path.join(staging, "graph.json"), graphText);
      assertBuildActive(deadline);
      await writeAtomic(path.join(staging, "snapshot.json"), `${JSON.stringify(metadata)}\n`);
      assertBuildActive(deadline);
      await rm(path.join(staging, "graphify-out"), { recursive: true, force: true });
      assertBuildActive(deadline);

      const generationDirectory = path.join(paths.generations, generation);
      await rename(staging, generationDirectory);
      staging = undefined;
      unpublishedGeneration = generationDirectory;
      await writeAtomic(paths.current, `${JSON.stringify({ generation })}\n`, () => assertBuildActive(deadline));
      unpublishedGeneration = undefined;

      return {
        ok: true,
        backend: "graphify",
        paths,
        snapshot: metadata,
        active: { generation, directory: generationDirectory, graph: path.join(generationDirectory, "graph.json"), snapshot: path.join(generationDirectory, "snapshot.json"), pointer: paths.current },
        stdout: truncateUtf8(result.stdout, MAX_QUERY_OUTPUT_BYTES).value,
        ...(result.stderr ? { stderr: truncateUtf8(result.stderr, MAX_QUERY_OUTPUT_BYTES).value } : {}),
      };
    } catch (error) {
      return { ok: false, backend: "graphify", paths, error: errorMessage(error) };
    } finally {
      deadline?.dispose();

      if (staging) {
        await rm(staging, { recursive: true, force: true });
      }

      if (unpublishedGeneration) {
        await rm(unpublishedGeneration, { recursive: true, force: true });
      }
    }
  }

  async function queryGraphFor({ cwd, agentDir, query, signal } = {}) {
    let paths;

    try {
      paths = await workspaceMemoryPaths({ cwd, agentDir });

      if (typeof query !== "string" || !query.trim()) {
        return { ok: false, backend: "graphify", paths, error: "A non-empty graph query is required." };
      }

      if (query.length > MAX_QUERY_CHARS) {
        return { ok: false, backend: "graphify", paths, error: `Graph query exceeds ${MAX_QUERY_CHARS} characters.` };
      }

      const current = await activeSnapshot(paths);

      if (!current.available) {
        return { ok: false, backend: "graphify", paths, error: current.error ?? "No active graph is available. Build it first." };
      }

      if (signal?.aborted) {
        throw new Error("Graphify query was cancelled.");
      }

      const dependencies = await runtime.ensureDependencies({ agentDir, signal });
      const environment = await prepareRuntime(paths, dependencies.python);
      const result = await runtime.runProcess(
        dependencies.python,
        ["-I", "-m", "graphify", "query", query, "--graph", current.active.graph, "--budget", "1200"],
        {
          cwd: paths.directory,
          env: { ...environment.environment, GRAPHIFY_QUERY_LOG_DISABLE: "1", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1" },
          timeoutMs: QUERY_TIMEOUT_MS,
          signal,
          maxBytes: MAX_PROCESS_OUTPUT_BYTES,
        },
      );

      const output = truncateUtf8(result.stdout, MAX_QUERY_OUTPUT_BYTES);
      const stderr = truncateUtf8(result.stderr, MAX_QUERY_OUTPUT_BYTES);

      return {
        ok: true,
        backend: "graphify",
        paths,
        query,
        active: current.active,
        output: output.value,
        ...(output.truncated ? { outputTruncated: true } : {}),
        ...(stderr.value ? { stderr: stderr.value } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {}),
      };
    } catch (error) {
      return { ok: false, backend: "graphify", paths, error: errorMessage(error) };
    }
  }

  return Object.freeze({ graphStatus: graphStatusFor, buildGraph: buildGraphFor, queryGraph: queryGraphFor });
}

const defaultGraphify = createGraphify();
export const graphStatus = defaultGraphify.graphStatus;
export const buildGraph = defaultGraphify.buildGraph;
export const queryGraph = defaultGraphify.queryGraph;
