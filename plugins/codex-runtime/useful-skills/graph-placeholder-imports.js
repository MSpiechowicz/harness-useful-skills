import { lstatSync } from "node:fs";
import path from "node:path";

import { replaceEdges, stagedGraphParts } from "./graph-import-provenance.js";
import { isBarePackageSpecifier, isGeneratedOutput, sourcePolicyError } from "./graph-validation.js";

const TEMPLATE_PLACEHOLDER = /\$\{[^{}]*\}/;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isPlaceholderSpecifier(label) {
  if (typeof label !== "string" || !TEMPLATE_PLACEHOLDER.test(label)) {
    return false;
  }

  if (label.startsWith(".") || label.startsWith("/") || label.startsWith("\\")) {
    return false;
  }

  return !SCHEME_PREFIX.test(label)
    && !path.isAbsolute(label)
    && !path.win32.isAbsolute(label);
}

function isPlaceholderImportImporter(edge, node, nodesById) {
  if (edge.relation !== "dynamic_import"
    || edge._origin !== "ast"
    || edge.source_location !== undefined) {
    return false;
  }

  const importer = nodesById.get(edge.source);

  return Boolean(importer)
    && importer.id !== node.id
    && importer._origin === "ast"
    && importer.file_type === "code"
    && typeof importer.source_file === "string"
    && Boolean(importer.source_file)
    && edge.source_file === importer.source_file;
}

function isUnresolvablePlaceholderImport(node, parts) {
  if (node._origin !== "ast"
    || node.file_type !== "code"
    || node.source_location !== undefined
    || node.label !== node.source_file
    || !isPlaceholderSpecifier(node.label)) {
    return false;
  }

  const incoming = parts.relations.incoming.get(node.id);
  if (!incoming?.length || parts.relations.outgoing.has(node.id)) {
    return false;
  }

  return incoming.every((edge) => isPlaceholderImportImporter(edge, node, parts.nodesById));
}

const IMPORT_RELATIONS = new Set(["dynamic_import", "imports", "imports_from"]);

// The file a relative specifier names from its importer: that path, or that path with an extension added.
function namesImportTarget(importerFile, specifier, sourceFile) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importerFile.replaceAll("\\", "/")), specifier));
  const target = sourceFile.replaceAll("\\", "/");

  return target === resolved
    || (target.startsWith(`${resolved}.`) && !target.slice(resolved.length + 1).includes("/"));
}

function isGeneratedImportImporter(edge, node, nodesById) {
  if (!IMPORT_RELATIONS.has(edge.relation) || edge._origin !== "ast") {
    return false;
  }

  const importer = nodesById.get(edge.source);

  return Boolean(importer)
    && importer.id !== node.id
    && importer._origin === "ast"
    && importer.file_type === "code"
    && typeof importer.source_file === "string"
    && Boolean(importer.source_file)
    && edge.source_file === importer.source_file
    && namesImportTarget(importer.source_file, node.label, node.source_file);
}

function isGeneratedImportTarget(node, parts, workspace) {
  if (node._origin !== "ast"
    || node.file_type !== "code"
    || node.source_location !== undefined
    || typeof node.label !== "string"
    || !(node.label.startsWith("./") || node.label.startsWith("../"))
    || !isGeneratedOutput(node.source_file, workspace)) {
    return false;
  }

  const incoming = parts.relations.incoming.get(node.id);
  if (!incoming?.length || parts.relations.outgoing.has(node.id)) {
    return false;
  }

  return incoming.every((edge) => isGeneratedImportImporter(edge, node, parts.nodesById));
}

function isSvelteImporter(node) {
  return node._origin === "ast"
    && node.file_type === "code"
    && typeof node.source_file === "string"
    && node.source_file.endsWith(".svelte");
}

function isSvelteImportEdge(edge, node, nodesById) {
  if (edge.relation !== "imports_from" || edge._origin !== "ast" || edge.source_location !== undefined) {
    return false;
  }

  const importer = nodesById.get(edge.source);

  return Boolean(importer)
    && importer.id !== node.id
    && isSvelteImporter(importer)
    && edge.source_file === importer.source_file;
}

// A package name that is also a workspace entry may be a local alias, so its stub is kept and validated.
function namesWorkspaceEntry(specifier, workspace) {
  try {
    lstatSync(path.join(workspace, specifier.split("/")[0]));
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function isSveltePackageImport(node, parts, workspace, hasSvelteImporter) {
  if (!hasSvelteImporter
    || node._origin !== "ast"
    || node.file_type !== "code"
    || node.source_location !== undefined
    || node.label !== node.source_file
    || !isBarePackageSpecifier(node.label)
    || sourcePolicyError(node.label, workspace) !== undefined
    || namesWorkspaceEntry(node.label, workspace)
    || parts.relations.outgoing.has(node.id)) {
    return false;
  }

  const incoming = parts.relations.incoming.get(node.id) ?? [];

  return incoming.every((edge) => isSvelteImportEdge(edge, node, parts.nodesById));
}

function dropNodes(contents, matches) {
  const parts = stagedGraphParts(contents);
  if (!parts) {
    return { contents, dropped: false };
  }

  const removedNodeIds = new Set(contents.nodes
    .filter((node) => matches(node, parts))
    .map((node) => node.id));
  if (!removedNodeIds.size) {
    return { contents, dropped: false };
  }

  contents.nodes = contents.nodes.filter((node) => !removedNodeIds.has(node.id));
  const retainedEdges = parts.edges.filter((edge) => !removedNodeIds.has(edge.target));
  replaceEdges(parts.edges, retainedEdges);

  return { contents, dropped: true };
}

// Graphify's regex rescue turns `import('${name}')` text inside template strings
// into stub nodes whose label and source_file are the raw placeholder specifier.
export function dropUnresolvablePlaceholderImports(contents) {
  return dropNodes(contents, isUnresolvablePlaceholderImport);
}

// Graphify adds a stub node for a relative import whose target it did not read, such as a gitignored
// build file. A stub naming generated output holds no source, so it goes with its import edges instead of
// failing the build. A generated file Graphify did read keeps failing validation.
export function dropGeneratedImportTargets(contents, workspace) {
  return dropNodes(contents, (node, parts) => isGeneratedImportTarget(node, parts, workspace));
}

// For a package import in a Svelte component, such as `svelte/motion`, Graphify can emit a code stub named
// after the package, linked by an unlocated `imports_from` edge or by nothing. A stub with a bare package name
// that no workspace entry shares names no local file, so it is dropped with its edges. Edgeless stubs go only
// when the graph has a Svelte component. Any other stub, or one linked from another importer, is validated.
export function dropSveltePackageImports(contents, workspace) {
  let hasSvelteImporter;

  return dropNodes(contents, (node, parts) => {
    hasSvelteImporter ??= [...parts.nodesById.values()].some(isSvelteImporter);
    return isSveltePackageImport(node, parts, workspace, hasSvelteImporter);
  });
}
