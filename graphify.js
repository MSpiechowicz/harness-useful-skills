import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { dependencyStatus, ensureDependencies } from "./dependencies.js";
import { minimalEnvironment, runProcess } from "./process.js";

const BUILD_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_QUERY_CHARS = 4_096;
const MAX_QUERY_OUTPUT_BYTES = 8 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_GRAPH_BYTES = 512 * 1024 * 1024;
const MAX_POINTER_BYTES = 4 * 1024;
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GENERATED_DIRECTORIES = new Set([
  ".angular", ".cache", ".graphify", ".next", ".nuxt", ".parcel-cache", ".svelte-kit",
  ".terraform", ".turbo", "build", "coverage", "dist", "generated", "graphify-out", "node_modules", "out",
]);
const CREDENTIAL_DIRECTORIES = new Set([".aws", ".gcloud", ".gnupg", ".ssh"]);
const CREDENTIAL_FILE = /(^\.env(?:\.|$)|\.(?:pem|key|p12|pfx|cert|crt|der|p8)$|^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|secring)(?:\.|$)|^(?:\.netrc|\.pgpass|\.htpasswd|\.npmrc|\.pypirc|\.git-credentials|\.boto)$)/i;
const GENERATED_FILE = /(?:\.generated\.|\.min\.(?:js|css)$)/i;

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= maximum) return { value: bytes.toString("utf8"), truncated: false };
  return { value: new TextDecoder("utf-8").decode(bytes.subarray(0, maximum), { stream: true }), truncated: true };
}

function errorMessage(error) {
  return truncateUtf8(error instanceof Error ? error.message : String(error), MAX_ERROR_BYTES).value;
}

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
  if (!deadline.signal.aborted) return;
  if (deadline.signal.reason === deadline.timeoutError) throw deadline.timeoutError;
  throw new Error("Graphify build was cancelled.");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containedIn(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function regularFile(file, description) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${description} must be a regular file.`);
  return details;
}

// Import concepts and unresolved AST references have no local source file.
function isSourceLessReference(node) {
  if (node.source_file !== "" || typeof node.label !== "string" || !node.label) return false;
  return (node.external === true && node.type === "external" && node.file_type === "concept")
    || (node._origin === "ast" && node.file_type === "code" && node.source_location === "");
}

function isExternalImportCandidate(node) {
  return node._origin === "ast"
    && node.file_type === "code"
    && node.source_location === undefined
    && typeof node.label === "string"
    && Boolean(node.label)
    && typeof node.source_file === "string"
    && Boolean(node.source_file);
}

function isRelativeImportSpecifier(specifier) {
  return typeof specifier === "string"
    && (specifier.startsWith("./") || specifier.startsWith("../"));
}

function isExternalImportSpecifier(sourceFile) {
  if (typeof sourceFile !== "string" || !sourceFile || /[\s\\\u0000-\u001f]/.test(sourceFile)) return false;
  if (path.isAbsolute(sourceFile) || path.win32.isAbsolute(sourceFile) || /^[A-Za-z]:/.test(sourceFile)) return false;

  if (/^https:\/\//i.test(sourceFile)) {
    try {
      const url = new URL(sourceFile);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  if (isRelativeImportSpecifier(sourceFile) || sourceFile.startsWith("~") || sourceFile.startsWith("#")) return false;
  if (sourceFile.startsWith("node:")) {
    const builtinParts = sourceFile.slice("node:".length).split("/");
    return builtinParts.every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part));
  }
  if (sourceFile.includes(":") || sourceFile.includes("?") || sourceFile.includes("#")) return false;

  const parts = sourceFile.split("/");
  const isPackagePart = (part) => part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part);
  if (parts[0].startsWith("@")) {
    return parts.length > 1
      && /^@[A-Za-z0-9._~-]+$/.test(parts[0])
      && parts.slice(1).every(isPackagePart);
  }
  return parts.every(isPackagePart);
}

function importRelations(edges) {
  const incoming = new Map();
  const outgoing = new Set();
  for (const edge of edges) {
    outgoing.add(edge.source);
    let links = incoming.get(edge.target);
    if (!links) {
      links = [];
      incoming.set(edge.target, links);
    }
    links.push(edge);
  }
  return { incoming, outgoing };
}

function isExternalImportReference(node, nodesById, relations) {
  if (!isExternalImportCandidate(node)
    || isRelativeImportSpecifier(node.label)
    || !isExternalImportSpecifier(node.source_file)) return false;
  if (relations.outgoing.has(node.id)) return false;
  const edges = relations.incoming.get(node.id);
  if (!edges?.length) return false;

  for (const edge of edges) {
    if (edge.relation !== "dynamic_import" || edge._origin !== "ast") return false;

    const importer = nodesById.get(edge.source);
    if (!importer
      || importer.id === node.id
      || importer._origin !== "ast"
      || importer.file_type !== "code"
      || typeof importer.source_file !== "string"
      || !importer.source_file
      || edge.source_file !== importer.source_file) return false;
  }
  return true;
}

function sourcePolicyError(sourceFile, workspace) {
  if (typeof sourceFile !== "string" || !sourceFile) return "Graph node source_file must be a non-empty string.";
  const sourcePath = path.resolve(workspace, sourceFile);
  if (!containedIn(sourcePath, workspace)) return `Graph node source file escapes the workspace: ${sourceFile}`;
  const relative = path.relative(workspace, sourcePath).split(path.sep);
  const lower = relative.map((part) => part.toLowerCase());
  if (lower.some((part) => GENERATED_DIRECTORIES.has(part)) || GENERATED_FILE.test(lower.at(-1))) return `Graph node source file is in generated output: ${sourceFile}`;
  if (lower.slice(0, -1).some((part) => CREDENTIAL_DIRECTORIES.has(part)) || CREDENTIAL_FILE.test(lower.at(-1))) {
    return `Graph node source file is credential-shaped: ${sourceFile}`;
  }
  return undefined;
}

async function validateSource(sourceFile, workspace) {
  const policyError = sourcePolicyError(sourceFile, workspace);
  if (policyError) return policyError;
  const sourcePath = path.resolve(workspace, sourceFile);
  try {
    const resolved = await realpath(sourcePath);
    if (!containedIn(resolved, workspace)) return `Graph node source file resolves outside the workspace: ${sourceFile}`;
    if (!(await stat(resolved)).isFile()) return `Graph node source file is not a regular file: ${sourceFile}`;
  } catch (error) {
    return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
  }
  return undefined;
}

async function validateExternalImportSource(sourceFile, workspace) {
  const policyError = sourcePolicyError(sourceFile, workspace);
  if (policyError) return policyError;
  const sourcePath = path.resolve(workspace, sourceFile);

  let existingWorkspaceDirectory = false;
  const segments = path.relative(workspace, sourcePath).split(path.sep);
  let current = workspace;
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(current, segment);
    try {
      await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (index > 0 && existingWorkspaceDirectory) {
          return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
        }
        return undefined;
      }
      return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
    }

    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
    }
    if (!containedIn(resolved, workspace)) return `Graph node source file resolves outside the workspace: ${sourceFile}`;

    const hasRemainingSegments = index < segments.length - 1;
    let isDirectory;
    if (index === 0 || hasRemainingSegments) {
      isDirectory = (await stat(resolved)).isDirectory();
    }
    if (index === 0) existingWorkspaceDirectory = isDirectory;
    if (hasRemainingSegments && !isDirectory) {
      return `Graph node source path is not a directory: ${sourceFile}`;
    }
    current = resolved;
  }

  return validateSource(sourceFile, workspace);
}

function graphValidationError(contents, workspace) {
  if (!isObject(contents) || !Array.isArray(contents.nodes)) return "Graphify graph must be an object with a nodes array.";
  const edges = contents.edges ?? contents.links;
  if (!Array.isArray(edges)) return "Graphify graph must contain an edges or links array.";

  const ids = new Set();
  const nodesById = new Map();
  for (const node of contents.nodes) {
    if (!isObject(node) || typeof node.id !== "string" || !node.id || ids.has(node.id)) return "Graphify graph nodes must have unique non-empty string ids.";
    ids.add(node.id);
    nodesById.set(node.id, node);
  }

  for (const edge of edges) {
    if (!isObject(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || !edge.source || !edge.target || !ids.has(edge.source) || !ids.has(edge.target) || typeof edge.relation !== "string" || !edge.relation) {
      return "Graphify graph edges must reference graph node ids and have a relation.";
    }
  }

  const relations = importRelations(edges);

  for (const node of contents.nodes) {
    if (isSourceLessReference(node)) continue;
    const sourceError = sourcePolicyError(node.source_file, workspace);
    if (sourceError) return sourceError;
    if (isExternalImportCandidate(node)
      && !isRelativeImportSpecifier(node.label)
      && isExternalImportSpecifier(node.source_file)
      && !isExternalImportReference(node, nodesById, relations)) {
      return "Graphify external AST import references must be leaf nodes linked only by dynamic_import edges from local source files.";
    }
  }
  return undefined;
}

async function graphContents(graphPath, workspace) {
  let details;
  try {
    details = await regularFile(graphPath, "Active graph");
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false };
    return { available: false, error: `Cannot inspect active graph: ${errorMessage(error)}` };
  }
  if (details.size > MAX_GRAPH_BYTES) return { available: false, error: "Active graph exceeds the 512 MiB safety limit." };
  try {
    const text = await readFile(graphPath, "utf8");
    const contents = JSON.parse(text);
    const error = graphValidationError(contents, workspace);
    if (error) return { available: false, error };
    return { available: true, contents, text };
  } catch (error) {
    return { available: false, error: `Active graph is invalid: ${errorMessage(error)}` };
  }
}

async function writeAtomic(file, contents, beforeRename) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: PRIVATE_FILE_MODE });
    beforeRename?.();
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function existingDirectory(directory, description) {
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${description} must be a non-symlink directory.`);
  return details;
}

async function checkExistingManagedPath(paths) {
  const directories = [path.join(paths.agentDir, "useful-skills"), path.dirname(paths.directory), paths.directory, paths.generations, paths.runtime];
  for (const current of directories) {
    try {
      await existingDirectory(current, "Managed memory path");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

async function privateChild(parent, name) {
  const directory = path.join(parent, name);
  try {
    await existingDirectory(directory, "Managed memory ancestor");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await mkdir(directory, { mode: PRIVATE_MODE });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
  }
  const details = await existingDirectory(directory, "Managed memory ancestor");
  await chmod(directory, PRIVATE_MODE);
  if ((details.mode & 0o077) !== 0) {
    const verified = await existingDirectory(directory, "Managed memory ancestor");
    if ((verified.mode & 0o077) !== 0) throw new Error("Managed memory ancestors must be private.");
  }
  return directory;
}

async function prepareStorage(paths) {
  await existingDirectory(paths.agentDir, "Agent profile directory");
  const featureRoot = await privateChild(paths.agentDir, "useful-skills");
  const memoryRoot = await privateChild(featureRoot, "memory");
  const directory = await privateChild(memoryRoot, paths.workspaceHash);
  const generations = await privateChild(directory, "generations");
  const runtime = await privateChild(directory, "runtime");
  if (directory !== paths.directory || generations !== paths.generations || runtime !== paths.runtime) throw new Error("Managed memory path did not remain canonical.");
  try {
    const current = await lstat(paths.current);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("Active graph pointer must be a regular file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function graphEnvironment(paths, python) {
  const home = path.join(paths.runtime, "home");
  const cache = path.join(paths.runtime, "cache");
  const tmp = path.join(paths.runtime, "tmp");
  return {
    home,
    cache,
    tmp,
    environment: minimalEnvironment({ home, cache, tmp, pathEntries: [path.dirname(python)] }),
  };
}

async function prepareRuntime(paths, python) {
  await prepareStorage(paths);
  const environment = graphEnvironment(paths, python);
  await Promise.all([privateChild(paths.runtime, "home"), privateChild(paths.runtime, "cache"), privateChild(paths.runtime, "tmp")]);
  return environment;
}

async function activeSnapshot(paths) {
  let pointer;
  try {
    const details = await regularFile(paths.current, "Active graph pointer");
    if (details.size > MAX_POINTER_BYTES) return { available: false, error: "Active graph pointer exceeds the safety limit." };
    pointer = JSON.parse(await readFile(paths.current, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false };
    return { available: false, error: `Active graph pointer is invalid: ${errorMessage(error)}` };
  }
  if (!isObject(pointer) || typeof pointer.generation !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(pointer.generation)) {
    return { available: false, error: "Active graph pointer has an invalid generation." };
  }
  const directory = path.join(paths.generations, pointer.generation);
  try {
    await existingDirectory(directory, "Active graph generation");
  } catch (error) {
    return { available: false, error: `Active graph generation is invalid: ${errorMessage(error)}` };
  }
  const graph = await graphContents(path.join(directory, "graph.json"), paths.workspace);
  if (!graph.available) return graph;
  try {
    await regularFile(path.join(directory, "snapshot.json"), "Active graph metadata");
    const metadata = JSON.parse(await readFile(path.join(directory, "snapshot.json"), "utf8"));
    if (!isObject(metadata) || metadata.generation !== pointer.generation) return { available: false, error: "Active graph metadata does not match its generation." };
    return { ...graph, metadata, active: { generation: pointer.generation, directory, graph: path.join(directory, "graph.json"), snapshot: path.join(directory, "snapshot.json"), pointer: paths.current } };
  } catch (error) {
    return { available: false, error: `Active graph metadata is invalid: ${errorMessage(error)}` };
  }
}

export async function workspaceMemoryPaths({ cwd, agentDir }) {
  if (typeof cwd !== "string" || !cwd) throw new Error("A workspace cwd is required.");
  if (typeof agentDir !== "string" || !agentDir) throw new Error("An agent profile directory is required.");
  let workspace;
  let profile;
  try {
    workspace = await realpath(cwd);
    profile = await realpath(agentDir);
  } catch (error) {
    throw new Error(`Cannot resolve workspace or agent profile: ${errorMessage(error)}`);
  }
  if (path.resolve(agentDir) !== profile) throw new Error("Agent profile paths must not contain symbolic links.");
  await existingDirectory(workspace, "Workspace directory");
  await existingDirectory(profile, "Agent profile directory");
  const workspaceHash = createHash("sha256").update(workspace).digest("hex");
  const directory = path.join(profile, "useful-skills", "memory", workspaceHash);
  if (containedIn(directory, workspace)) throw new Error("Managed memory storage must be outside the workspace.");
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
  });

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
      if (signal?.aborted) throw new Error("Graphify build was cancelled.");
      await prepareStorage(paths);
      const dependencies = await runtime.ensureDependencies({ agentDir, signal });
      deadline = createBuildDeadline(signal);
      assertBuildActive(deadline);
      const environment = await prepareRuntime(paths, dependencies.python);
      assertBuildActive(deadline);
      const generation = randomUUID();
      staging = path.join(paths.generations, `.staging-${generation}`);
      await mkdir(staging, { mode: PRIVATE_MODE });
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
      const stagedGraph = await graphContents(path.join(staging, "graphify-out", "graph.json"), paths.workspace);
      assertBuildActive(deadline);
      if (!stagedGraph.available) throw new Error(stagedGraph.error ?? "Graphify did not produce a graph.");
      const graphHash = createHash("sha256").update(stagedGraph.text).digest("hex");
      const sourceFiles = new Set();
      const externalSources = new Set();
      const edges = stagedGraph.contents.edges ?? stagedGraph.contents.links;
      const relations = importRelations(edges);
      const nodesById = new Map(stagedGraph.contents.nodes.map((node) => [node.id, node]));
      for (const node of stagedGraph.contents.nodes) {
        if (isSourceLessReference(node)) continue;
        if (isExternalImportReference(node, nodesById, relations)) externalSources.add(node.source_file);
        else sourceFiles.add(node.source_file);
      }
      for (const sourceFile of sourceFiles) {
        assertBuildActive(deadline);
        const sourceError = await validateSource(sourceFile, paths.workspace);
        assertBuildActive(deadline);
        if (sourceError) throw new Error(sourceError);
      }
      for (const sourceFile of externalSources) {
        assertBuildActive(deadline);
        const sourceError = await validateExternalImportSource(sourceFile, paths.workspace);
        assertBuildActive(deadline);
        if (sourceError) throw new Error(sourceError);
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
      await writeAtomic(path.join(staging, "graph.json"), stagedGraph.text);
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
      if (staging) await rm(staging, { recursive: true, force: true });
      if (unpublishedGeneration) await rm(unpublishedGeneration, { recursive: true, force: true });
    }
  }

  async function queryGraphFor({ cwd, agentDir, query, signal } = {}) {
    let paths;
    try {
      paths = await workspaceMemoryPaths({ cwd, agentDir });
      if (typeof query !== "string" || !query.trim()) return { ok: false, backend: "graphify", paths, error: "A non-empty graph query is required." };
      if (query.length > MAX_QUERY_CHARS) return { ok: false, backend: "graphify", paths, error: `Graph query exceeds ${MAX_QUERY_CHARS} characters.` };
      const current = await activeSnapshot(paths);
      if (!current.available) return { ok: false, backend: "graphify", paths, error: current.error ?? "No active graph is available. Build it first." };
      if (signal?.aborted) throw new Error("Graphify query was cancelled.");
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
