import path from "node:path";

import { replaceEdges, stagedGraphParts } from "./graph-import-provenance.js";

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

// Graphify's regex rescue turns `import('${name}')` text inside template strings
// into stub nodes whose label and source_file are the raw placeholder specifier.
export function dropUnresolvablePlaceholderImports(contents) {
  const parts = stagedGraphParts(contents);
  if (!parts) {
    return { contents, dropped: false };
  }

  const removedNodeIds = new Set(contents.nodes
    .filter((node) => isUnresolvablePlaceholderImport(node, parts))
    .map((node) => node.id));
  if (!removedNodeIds.size) {
    return { contents, dropped: false };
  }

  contents.nodes = contents.nodes.filter((node) => !removedNodeIds.has(node.id));
  const retainedEdges = parts.edges.filter((edge) => !removedNodeIds.has(edge.target));
  replaceEdges(parts.edges, retainedEdges);

  return { contents, dropped: true };
}
