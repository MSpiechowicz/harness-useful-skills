import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importRelations, isHttpsImportCandidate, isLocalhostHttpImportCandidate, sourcePolicyError, validateSource } from "./graph-validation.js";
import { isPathWithin } from "./path-boundary.js";
import { isObject } from "./graph-safety.js";

const MAX_PROVENANCE_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROVENANCE_OUTPUT_BYTES = 1024 * 1024;
const PROVENANCE_TIMEOUT_MS = 30_000;
const JS_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const IMPORT_PROVENANCE_PARSER = fileURLToPath(new URL("./graph-import-provenance.py", import.meta.url));

/** Refill `edges` in place, one push at a time: spreading a graph-sized array into a call overflows the stack. */
export function replaceEdges(edges, items) {
  edges.length = 0;
  for (const item of items) {
    edges.push(item);
  }
}

export function stagedGraphParts(contents) {
  if (!isObject(contents) || !Array.isArray(contents.nodes)) {
    return undefined;
  }

  const edges = contents.edges ?? contents.links;
  if (!Array.isArray(edges)) {
    return undefined;
  }

  const nodesById = new Map();
  for (const node of contents.nodes) {
    if (!isObject(node) || typeof node.id !== "string" || !node.id || nodesById.has(node.id)) {
      return undefined;
    }

    nodesById.set(node.id, node);
  }

  for (const edge of edges) {
    if (!isObject(edge)
      || typeof edge.source !== "string"
      || typeof edge.target !== "string"
      || !nodesById.has(edge.source)
      || !nodesById.has(edge.target)
      || typeof edge.relation !== "string"
      || !edge.relation) {
      return undefined;
    }
  }

  return { edges, nodesById, relations: importRelations(edges) };
}

function isLocalFileImporter(node, sourceFile) {
  return node._origin === "ast"
    && node.file_type === "code"
    && node.source_file === sourceFile
    && node.source_location === "L1"
    && typeof node.label === "string"
    && Boolean(node.label);
}

function localJavaScriptSource(sourceFile) {
  return typeof sourceFile === "string"
    && Boolean(sourceFile)
    && !/^https?:\/\//i.test(sourceFile)
    && !path.isAbsolute(sourceFile)
    && !path.win32.isAbsolute(sourceFile)
    && !/^[A-Za-z]:/.test(sourceFile)
    && JS_SOURCE_EXTENSIONS.has(path.extname(sourceFile).toLowerCase());
}

function safeRelativeSpecifier(specifier) {
  return typeof specifier === "string"
    && (specifier.startsWith("./") || specifier.startsWith("../"))
    && !path.isAbsolute(specifier)
    && !path.win32.isAbsolute(specifier)
    && !/[\\\u0000-\u001f\u007f?#]/.test(specifier);
}

function collectImporters(contents) {
  const importersBySource = new Map();

  for (const node of contents.nodes) {
    const sourceFile = node.source_file;
    if (!localJavaScriptSource(sourceFile) || !isLocalFileImporter(node, sourceFile)) {
      continue;
    }

    let importers = importersBySource.get(sourceFile);
    if (!importers) {
      importers = [];
      importersBySource.set(sourceFile, importers);
    }

    importers.push(node);
  }

  return importersBySource;
}

async function parserSources(importersBySource, workspace, assertActive) {
  const sources = [];

  for (const [sourceFile, importers] of importersBySource) {
    if (importers.length !== 1
      || !localJavaScriptSource(sourceFile)
      || sourcePolicyError(sourceFile, workspace)) {
      continue;
    }

    assertActive();
    const sourceError = await validateSource(sourceFile, workspace);
    assertActive();
    if (sourceError) {
      continue;
    }

    try {
      const resolved = await realpath(path.resolve(workspace, sourceFile));
      if (isPathWithin(workspace, resolved) && !sourcePolicyError(resolved, workspace)) {
        sources.push({ sourceFile, path: resolved });
      }
    } catch {
      // A source that cannot be resolved is not evidence for an import.
    }
  }

  return sources;
}

function stagedLocalImportCandidate(node, parts, importersBySource, workspace) {
  if (node._origin !== "ast"
    || node.file_type !== "code"
    || node.source_location !== undefined
    || !safeRelativeSpecifier(node.label)
    || typeof node.source_file !== "string"
    || !node.source_file
    || /^https?:\/\//i.test(node.source_file)
    || path.isAbsolute(node.source_file)
    || path.win32.isAbsolute(node.source_file)) {
    return undefined;
  }

  const incoming = parts.relations.incoming.get(node.id);
  if (incoming?.length !== 1 || parts.relations.outgoing.has(node.id)) {
    return undefined;
  }

  const edge = incoming[0];
  const importer = parts.nodesById.get(edge.source);
  const importers = importer && importersBySource.get(importer.source_file);
  if (edge.relation !== "dynamic_import"
    || edge._origin !== "ast"
    || edge.source_location !== undefined
    || !importer
    || !isLocalFileImporter(importer, importer.source_file)
    || edge.source_file !== importer.source_file
    || importers?.length !== 1
    || importers[0].id !== importer.id) {
    return undefined;
  }

  const importerPath = path.resolve(workspace, importer.source_file);
  const targetPath = path.resolve(path.dirname(importerPath), node.label);
  if (!isPathWithin(workspace, targetPath)) {
    return undefined;
  }

  const targetSourceFile = path.relative(workspace, targetPath).split(path.sep).join("/");
  if (!targetSourceFile
    || node.source_file !== targetSourceFile
    || sourcePolicyError(targetSourceFile, workspace)) {
    return undefined;
  }

  return { node, edge, importer, importerPath, targetPath, targetSourceFile, specifier: node.label };
}

async function missingSafeTarget(candidate, workspace, source, assertActive) {
  if (!source || source.path !== candidate.importerPath) {
    return false;
  }

  const relative = path.relative(workspace, candidate.targetPath);
  if (!relative || !isPathWithin(workspace, candidate.targetPath)) {
    return false;
  }

  let current = workspace;
  const segments = relative.split(path.sep);

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    assertActive();

    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      assertActive();
      return error?.code === "ENOENT";
    }

    assertActive();
    if (info.isSymbolicLink()) {
      return false;
    }

    if (index === segments.length - 1) {
      return false;
    }

    if (!info.isDirectory()) {
      return false;
    }
  }

  return false;
}

function uniqueLocalCandidates(candidates) {
  const counts = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.importer.source_file}\0${candidate.specifier}\0${candidate.targetSourceFile}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return candidates.filter((candidate) => {
    const key = `${candidate.importer.source_file}\0${candidate.specifier}\0${candidate.targetSourceFile}`;
    return counts.get(key) === 1;
  });
}

export async function inspectDynamicImportWitnesses({
  python,
  environment,
  runProcess,
  staging,
  signal,
  sources,
  targets,
  inertTargets,
  assertActive,
}) {
  const manifest = JSON.stringify({ sources, targets, inertTargets });
  if (Buffer.byteLength(manifest) > MAX_PROVENANCE_INPUT_BYTES) {
    return { ok: false, error: "manifest-too-large" };
  }

  const manifestPath = path.join(staging, `.import-provenance-${randomUUID()}.json`);
  await writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 });

  try {
    assertActive();
    const result = await runProcess(python, ["-I", "-B", IMPORT_PROVENANCE_PARSER, manifestPath], {
      cwd: staging,
      env: environment.environment,
      signal,
      timeoutMs: PROVENANCE_TIMEOUT_MS,
      maxBytes: MAX_PROVENANCE_OUTPUT_BYTES,
    });
    assertActive();

    let verdict;
    try {
      verdict = JSON.parse(result.stdout);
    } catch {
      return { ok: false, error: "invalid-parser-output" };
    }

    if (!isObject(verdict) || typeof verdict.ok !== "boolean") {
      return { ok: false, error: "invalid-parser-verdict" };
    }

    if (!verdict.ok) {
      return typeof verdict.error === "string"
        ? verdict
        : { ok: false, error: "parser-rejected-source" };
    }

    if (!Array.isArray(verdict.witnesses) || !Array.isArray(verdict.inertMatches)) {
      return { ok: false, error: "invalid-parser-verdict" };
    }

    return verdict;
  } finally {
    await rm(manifestPath, { force: true });
  }
}

export async function repairMissingExternalImportEdges({
  contents,
  workspace,
  python,
  environment,
  runProcess,
  staging,
  signal,
  assertActive,
  inspectWitnesses = inspectDynamicImportWitnesses,
}) {
  const parts = stagedGraphParts(contents);
  if (!parts) {
    return false;
  }

  const importersBySource = collectImporters(contents);
  const httpsOrphans = contents.nodes.filter((node) => isHttpsImportCandidate(node)
    && !parts.relations.incoming.has(node.id)
    && !parts.relations.outgoing.has(node.id));
  const localhostReferences = contents.nodes.filter((node) => isLocalhostHttpImportCandidate(node)
    && !parts.relations.outgoing.has(node.id));
  const localCandidates = uniqueLocalCandidates(contents.nodes.map((node) => stagedLocalImportCandidate(
    node, parts, importersBySource, workspace,
  )).filter(Boolean));

  if (!httpsOrphans.length && !localhostReferences.length && !localCandidates.length) {
    return false;
  }

  const sources = await parserSources(importersBySource, workspace, assertActive);
  assertActive();
  const sourcesByFile = new Map(sources.map((source) => [source.sourceFile, source]));
  const missingLocalCandidates = [];

  for (const candidate of localCandidates) {
    if (await missingSafeTarget(candidate, workspace, sourcesByFile.get(candidate.importer.source_file), assertActive)) {
      missingLocalCandidates.push(candidate);
    }
  }

  if (!httpsOrphans.length && !localhostReferences.length && !missingLocalCandidates.length) {
    return false;
  }

  const urls = [...new Set([
    ...httpsOrphans.map((node) => node.source_file),
    ...localhostReferences.map((node) => node.source_file),
  ])];
  const specifiers = [...new Set(missingLocalCandidates.map((candidate) => candidate.specifier))];
  const targets = [...new Set([...urls, ...specifiers])];
  const inertTargets = [...new Map(missingLocalCandidates.map((candidate) => {
    const key = `${candidate.importer.source_file}\0${candidate.specifier}`;
    return [key, {
      sourceFile: candidate.importer.source_file,
      specifier: candidate.specifier,
      targetPath: candidate.targetPath,
    }];
  })).values()];

  const verdict = await inspectWitnesses({
    python,
    environment,
    runProcess,
    staging,
    signal,
    sources,
    targets,
    inertTargets,
    assertActive,
  });
  assertActive();

  if (!isObject(verdict) || verdict.ok !== true
    || !Array.isArray(verdict.witnesses) || !Array.isArray(verdict.inertMatches)) {
    const reason = isObject(verdict) && typeof verdict.error === "string" ? verdict.error : "invalid parser verdict";
    throw new Error(`Graphify could not verify staged import provenance: ${reason}.`);
  }

  const sourceFiles = new Set(sourcesByFile.keys());
  const targetSet = new Set(targets);
  const witnesses = verdict.witnesses.filter((witness) => isObject(witness)
    && sourceFiles.has(witness.sourceFile)
    && targetSet.has(witness.url)
    && typeof witness.sourceLocation === "string"
    && /^L[1-9][0-9]*$/.test(witness.sourceLocation));
  const inertMatchSet = new Set(verdict.inertMatches.filter((match) => isObject(match)
    && sourceFiles.has(match.sourceFile)
    && missingLocalCandidates.some((candidate) => candidate.importer.source_file === match.sourceFile
      && candidate.specifier === match.specifier))
    .map((match) => `${match.sourceFile}\0${match.specifier}`));
  const additions = new Map();

  for (const candidate of httpsOrphans) {
    for (const witness of witnesses) {
      if (witness.url !== candidate.source_file) {
        continue;
      }

      const importerNodes = importersBySource.get(witness.sourceFile);
      const importer = importerNodes?.length === 1 ? importerNodes[0] : undefined;
      if (!importer) {
        continue;
      }

      const key = `${importer.id}\0${candidate.id}`;
      if (!additions.has(key)) {
        additions.set(key, {
          source: importer.id,
          target: candidate.id,
          relation: "dynamic_import",
          _origin: "ast",
          source_file: importer.source_file,
          source_location: witness.sourceLocation,
        });
      }
    }
  }

  for (const reference of localhostReferences) {
    const matches = witnesses.filter((witness) => witness.url === reference.source_file);
    const importerFiles = new Set(matches.map((witness) => witness.sourceFile));
    if (importerFiles.size !== 1) {
      throw new Error("Graphify localhost HTTP imports require one exact dynamic-import witness from a unique local importer.");
    }

    const [sourceFile] = importerFiles;
    const importerNodes = importersBySource.get(sourceFile);
    const importer = importerNodes?.length === 1 ? importerNodes[0] : undefined;
    const source = sourcesByFile.get(sourceFile);
    if (!importer || !source) {
      throw new Error("Graphify localhost HTTP imports require one validated local AST importer.");
    }

    const incoming = parts.relations.incoming.get(reference.id) ?? [];
    if (incoming.length > 1) {
      throw new Error("Graphify localhost HTTP imports require a single dynamic_import relationship.");
    }

    const witness = matches[0];
    if (incoming.length === 1) {
      const edge = incoming[0];
      if (edge.source !== importer.id
        || edge.relation !== "dynamic_import"
        || edge._origin !== "ast"
        || edge.source_file !== importer.source_file
        || (edge.source_location !== undefined
          && !matches.some((match) => match.sourceLocation === edge.source_location))) {
        throw new Error("Graphify localhost HTTP relationship does not match its exact dynamic-import witness.");
      }
    } else {
      const key = `${importer.id}\0${reference.id}`;
      additions.set(key, {
        source: importer.id,
        target: reference.id,
        relation: "dynamic_import",
        _origin: "ast",
        source_file: importer.source_file,
        source_location: witness.sourceLocation,
      });
    }
  }

  const removedNodeIds = new Set();
  const removedEdges = new Set();

  for (const candidate of missingLocalCandidates) {
    const source = sourcesByFile.get(candidate.importer.source_file);
    const proofKey = `${candidate.importer.source_file}\0${candidate.specifier}`;
    if (!source
      || source.path !== candidate.importerPath
      || !inertMatchSet.has(proofKey)
      || witnesses.some((witness) => witness.sourceFile === candidate.importer.source_file
        && witness.url === candidate.specifier)) {
      continue;
    }

    const targetStillMissing = await missingSafeTarget(candidate, workspace, source, assertActive);
    if (!targetStillMissing) {
      continue;
    }

    removedNodeIds.add(candidate.node.id);
    removedEdges.add(candidate.edge);
  }

  if (!additions.size && !removedNodeIds.size) {
    return false;
  }

  assertActive();
  if (additions.size) {
    replaceEdges(parts.edges, [...parts.edges, ...additions.values()]);
  }

  if (removedNodeIds.size) {
    contents.nodes = contents.nodes.filter((node) => !removedNodeIds.has(node.id));
    const retainedEdges = parts.edges.filter((edge) => !removedEdges.has(edge));
    replaceEdges(parts.edges, retainedEdges);
  }

  return true;
}
