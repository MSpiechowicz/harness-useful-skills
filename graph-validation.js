import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isPathWithin } from "./path-boundary.js";
import { errorMessage, isObject } from "./graph-safety.js";

const GENERATED_DIRECTORIES = new Set([
  ".angular", ".cache", ".graphify", ".next", ".nuxt", ".parcel-cache", ".svelte-kit",
  ".terraform", ".turbo", "build", "coverage", "dist", "generated", "graphify-out", "node_modules", "out",
]);
const CREDENTIAL_DIRECTORIES = new Set([".aws", ".gcloud", ".gnupg", ".ssh"]);
const CREDENTIAL_FILE = /(^\.env(?:\.|$)|\.(?:pem|key|p12|pfx|cert|crt|der|p8)$|^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|secring)(?:\.|$)|^(?:\.netrc|\.pgpass|\.htpasswd|\.npmrc|\.pypirc|\.git-credentials|\.boto)$)/i;
const GENERATED_FILE = /(?:\.generated\.|\.min\.(?:js|css)$)/i;

// Import concepts and unresolved AST references have no local source file.
export function isSourceLessReference(node) {
  if (node.source_file !== "" || typeof node.label !== "string" || !node.label) {
    return false;
  }

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

function validPackagePart(part) {
  return part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part);
}

function isExternalImportSpecifier(sourceFile) {
  if (typeof sourceFile !== "string" || !sourceFile || /[\s\\\u0000-\u001f]/.test(sourceFile)) {
    return false;
  }

  if (path.isAbsolute(sourceFile) || path.win32.isAbsolute(sourceFile) || /^[A-Za-z]:/.test(sourceFile)) {
    return false;
  }

  if (/^https:\/\//i.test(sourceFile)) {
    try {
      const url = new URL(sourceFile);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  if (isRelativeImportSpecifier(sourceFile) || sourceFile.startsWith("~") || sourceFile.startsWith("#")) {
    return false;
  }

  if (sourceFile.startsWith("node:")) {
    const builtinParts = sourceFile.slice("node:".length).split("/");
    return builtinParts.every((part) => part && validPackagePart(part));
  }

  if (sourceFile.includes(":") || sourceFile.includes("?") || sourceFile.includes("#")) {
    return false;
  }

  const parts = sourceFile.split("/");

  if (parts[0].startsWith("@")) {
    return parts.length > 1
      && /^@[A-Za-z0-9._~-]+$/.test(parts[0])
      && parts.slice(1).every(validPackagePart);
  }

  return parts.every(validPackagePart);
}

export function importRelations(edges) {
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

export function isExternalImportReference(node, nodesById, relations) {
  if (!isExternalImportCandidate(node)
    || isRelativeImportSpecifier(node.label)
    || !isExternalImportSpecifier(node.source_file)) {
    return false;
  }

  if (relations.outgoing.has(node.id)) {
    return false;
  }

  const edges = relations.incoming.get(node.id);

  if (!edges?.length) {
    return false;
  }

  for (const edge of edges) {
    if (edge.relation !== "dynamic_import" || edge._origin !== "ast") {
      return false;
    }

    const importer = nodesById.get(edge.source);

    if (!importer
      || importer.id === node.id
      || importer._origin !== "ast"
      || importer.file_type !== "code"
      || typeof importer.source_file !== "string"
      || !importer.source_file
      || edge.source_file !== importer.source_file) {
      return false;
    }
  }

  return true;
}

export function sourcePolicyError(sourceFile, workspace, displaySourceFile = sourceFile) {
  if (typeof sourceFile !== "string" || !sourceFile) {
    return "Graph node source_file must be a non-empty string.";
  }

  const sourcePath = path.resolve(workspace, sourceFile);

  if (!isPathWithin(workspace, sourcePath)) {
    return `Graph node source file escapes the workspace: ${displaySourceFile}`;
  }

  const relative = path.relative(workspace, sourcePath).split(path.sep);
  const lower = relative.map((part) => part.toLowerCase());

  if (lower.some((part) => GENERATED_DIRECTORIES.has(part)) || GENERATED_FILE.test(lower.at(-1))) {
    return `Graph node source file is in generated output: ${displaySourceFile}`;
  }

  if (lower.slice(0, -1).some((part) => CREDENTIAL_DIRECTORIES.has(part)) || CREDENTIAL_FILE.test(lower.at(-1))) {
    return `Graph node source file is credential-shaped: ${displaySourceFile}`;
  }

  return undefined;
}

export async function validateSource(sourceFile, workspace) {
  const policyError = sourcePolicyError(sourceFile, workspace);

  if (policyError) {
    return policyError;
  }

  const sourcePath = path.resolve(workspace, sourceFile);

  try {
    const resolved = await realpath(sourcePath);

    if (!isPathWithin(workspace, resolved)) {
      return `Graph node source file resolves outside the workspace: ${sourceFile}`;
    }

    const canonicalPolicyError = sourcePolicyError(resolved, workspace, sourceFile);

    if (canonicalPolicyError) {
      return canonicalPolicyError;
    }

    if (!(await stat(resolved)).isFile()) {
      return `Graph node source file is not a regular file: ${sourceFile}`;
    }
  } catch (error) {
    return `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}`;
  }

  return undefined;
}

async function inspectImportSegment(candidate, sourceFile, workspace, first, remaining, existingWorkspaceDirectory) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" && (!existingWorkspaceDirectory || first)) {
      return { missingPackage: true };
    }

    return { error: `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}` };
  }

  let resolved;

  try {
    resolved = await realpath(candidate);
  } catch (error) {
    return { error: `Cannot verify graph node source file ${sourceFile}: ${errorMessage(error)}` };
  }

  if (!isPathWithin(workspace, resolved)) {
    return { error: `Graph node source file resolves outside the workspace: ${sourceFile}` };
  }

  let isDirectory;

  if (first || remaining) {
    isDirectory = (await stat(resolved)).isDirectory();
  }

  // A resolved directory may itself be credential-shaped; inspect it as a source ancestor.
  const canonicalPolicyPath = isDirectory ? path.join(resolved, "source") : resolved;
  const canonicalPolicyError = sourcePolicyError(canonicalPolicyPath, workspace, sourceFile);

  if (canonicalPolicyError) {
    return { error: canonicalPolicyError };
  }

  if (remaining && !isDirectory) {
    return { error: `Graph node source path is not a directory: ${sourceFile}` };
  }

  return { resolved, isDirectory };
}

export async function validateExternalImportSource(sourceFile, workspace) {
  const policyError = sourcePolicyError(sourceFile, workspace);

  if (policyError) {
    return policyError;
  }

  const segments = path.relative(workspace, path.resolve(workspace, sourceFile)).split(path.sep);
  let current = workspace;
  let existingWorkspaceDirectory = false;

  for (const [index, segment] of segments.entries()) {
    const first = index === 0;
    const remaining = index < segments.length - 1;
    const inspection = await inspectImportSegment(
      path.join(current, segment), sourceFile, workspace, first, remaining, existingWorkspaceDirectory,
    );

    if (inspection.error) {
      return inspection.error;
    }

    if (inspection.missingPackage) {
      return undefined;
    }

    if (first) {
      existingWorkspaceDirectory = inspection.isDirectory;
    }

    current = inspection.resolved;
  }

  return validateSource(sourceFile, workspace);
}

export function graphValidationError(contents, workspace) {
  if (!isObject(contents) || !Array.isArray(contents.nodes)) {
    return "Graphify graph must be an object with a nodes array.";
  }

  const edges = contents.edges ?? contents.links;

  if (!Array.isArray(edges)) {
    return "Graphify graph must contain an edges or links array.";
  }

  const ids = new Set();
  const nodesById = new Map();

  for (const node of contents.nodes) {
    if (!isObject(node) || typeof node.id !== "string" || !node.id || ids.has(node.id)) {
      return "Graphify graph nodes must have unique non-empty string ids.";
    }

    ids.add(node.id);
    nodesById.set(node.id, node);
  }

  for (const edge of edges) {
    if (!isObject(edge)
      || typeof edge.source !== "string"
      || typeof edge.target !== "string"
      || !edge.source
      || !edge.target
      || !ids.has(edge.source)
      || !ids.has(edge.target)
      || typeof edge.relation !== "string"
      || !edge.relation) {
      return "Graphify graph edges must reference graph node ids and have a relation.";
    }
  }

  const relations = importRelations(edges);

  for (const node of contents.nodes) {
    if (isSourceLessReference(node)) {
      continue;
    }

    const sourceError = sourcePolicyError(node.source_file, workspace);

    if (sourceError) {
      return sourceError;
    }

    if (isExternalImportCandidate(node)
      && !isRelativeImportSpecifier(node.label)
      && isExternalImportSpecifier(node.source_file)
      && !isExternalImportReference(node, nodesById, relations)) {
      return "Graphify external AST import references must be leaf nodes linked only by dynamic_import edges from local source files.";
    }
  }

  return undefined;
}
