import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const ECC_UPSTREAM = Object.freeze({
  repository: "affaan-m/ECC",
  version: "2.2.2",
  commit: "934195f955cf0da847d59fcd6f68856bce112d8b",
  url: "https://github.com/affaan-m/ECC",
});

const DISABLED_VALUES = new Set(["0", "false", "off", "none", "disabled"]);
const SECRET_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(\bBearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|password|passwd|secret)\b\s*[:=]\s*["']?)[^\s"'`]{8,}/gi,
];
const RECURSIVE_RM_SEGMENT = /\brm\s+([^;&|\n]*)/gi;
const RECURSIVE_RM_OPTION = /(?:^|\s)(?:-(?!-)[^\s]*r[^\s]*|--recursive)(?=\s|$)/i;
const CATASTROPHIC_RM_TARGET = /(?:^|\s)(?:\/+(?=\s|$)|~(?=\/|\s|$)|\.{1,2}\/?(?=\s|$)|"\/+"(?=\s|$)|'\/+'(?=\s|$)|"\.{1,2}\/?"(?=\s|$)|'\.{1,2}\/?'(?=\s|$))/i;
const RECURSIVE_RM_REASON = "blocked recursive deletion of a root, home, current, or dynamic target";
const DANGEROUS_COMMANDS = [
  {
    pattern: /\b(?:mkfs(?:\.[A-Za-z0-9_-]+)?|wipefs)\b[^\n]*\/(?:dev|sys|proc)\//i,
    reason: "blocked filesystem destruction against a system device",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|mmcblk\d+)/i,
    reason: "blocked raw-disk overwrite",
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:ba)?sh\b/i,
    reason: "blocked download-to-shell execution",
  },
];

function isDisabled(value) {
  return typeof value === "string" && DISABLED_VALUES.has(value.trim().toLowerCase());
}

function frontmatterField(contents, field) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
  const value = frontmatter && new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m").exec(frontmatter)?.[1];
  if (!value) {
    return undefined;
  }

  const quoted = /^("|')(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function entriesOptional(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function walkMarkdown(root) {
  const output = [];
  async function visit(directory) {
    const entries = await entriesOptional(directory);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        output.push(file);
      }
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

export function safetyEnabled(environment = process.env) {
  return !isDisabled(environment.OMP_ECC_SAFETY ?? environment.ECC_OMP_SAFETY);
}

export function dangerousCommandReason(command) {
  if (typeof command !== "string" || !command.trim()) {
    return undefined;
  }

  for (const [, segment] of command.matchAll(RECURSIVE_RM_SEGMENT)) {
    if (RECURSIVE_RM_OPTION.test(segment) && (/[$`*?]/.test(segment) || CATASTROPHIC_RM_TARGET.test(segment))) {
      return RECURSIVE_RM_REASON;
    }
  }

  return DANGEROUS_COMMANDS.find(({ pattern }) => pattern.test(command))?.reason;
}

export function redactText(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...matches) => {
      if (pattern.source.startsWith("(")) {
        const prefix = matches[1];
        return /^Bearer$/i.test(prefix) ? `${prefix} [REDACTED]` : `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

/** Reject secret-shaped facts before storage; output redaction is not storage protection. */
export function containsSecret(value) {
  return typeof value === "string" && SECRET_PATTERNS.some(pattern => new RegExp(pattern.source, pattern.flags).test(value));
}

export function redactToolResultContent(content) {
  if (!Array.isArray(content)) {
    return undefined;
  }

  let changed = false;
  const redacted = content.map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      return block;
    }

    const text = redactText(block.text);
    if (text === block.text) {
      return block;
    }

    changed = true;
    return { ...block, text };
  });
  return changed ? redacted : undefined;
}

const RESOURCE_KINDS = ["skills", "commands", "agents", "rules"];

export async function resourceInventory(options = {}) {
  const counts = await Promise.all(RESOURCE_KINDS.map(async kind => [kind, (await listResources(kind, options)).length]));
  return Object.fromEntries(counts);
}

/** One shallow skill catalog; archived references never become active skills. */
export async function listResources(kind, { root = PACKAGE_ROOT, query = "", source = "core" } = {}) {
  if (!RESOURCE_KINDS.includes(kind)) {
    throw new TypeError("Resource kind must be skills, commands, agents, or rules.");
  }

  if (!["core", "library"].includes(source)) {
    throw new TypeError("Resource source must be core or library.");
  }

  if (typeof query !== "string") {
    throw new TypeError("Resource query must be a string.");
  }

  const base = source === "core" ? root : path.join(root, "skills/us-library/references/ecc");
  const directory = path.join(base, kind);
  const entries = await entriesOptional(directory);
  const files = kind === "rules"
    ? await walkMarkdown(directory)
    : entries.filter(entry => kind === "skills" ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".md"))
      .map(entry => path.join(directory, entry.name, ...(kind === "skills" ? ["SKILL.md"] : [])));
  const items = await Promise.all(files.map(async file => {
    const contents = await readOptional(file);
    if (!contents) {
      return undefined;
    }

    const baseName = kind === "skills" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
    const name = frontmatterField(contents, "name") ?? baseName;
    const description = frontmatterField(contents, "description") ?? "";
    if (kind === "skills" && source === "core" && (name !== baseName || !frontmatterField(contents, "name") || !description)) {
      return undefined;
    }

    const relative = path.relative(root, file).split(path.sep).join("/");
    const uri = source === "library" ? `skill://us-library/references/ecc/${path.relative(base, file).split(path.sep).join("/")}` : undefined;
    const usage = uri ?? (kind === "skills" ? `/skill:${name}` : relative);
    return { name, description, path: relative, usage, ...(uri ? { uri } : {}) };
  }));

  const normalizedQuery = query.trim().toLowerCase();
  return items.filter(item => item && `${item.name} ${item.description} ${item.path}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Both the extension's text input and the launcher's argv use this parser. */
export function parseCatalogArguments(input) {
  const tokens = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : input;
  if (!Array.isArray(tokens) || tokens.some(token => typeof token !== "string")) {
    throw new TypeError("Expected catalog arguments.");
  }

  const library = tokens[0] === "library";
  const rest = library ? tokens.slice(1) : tokens;
  if (rest[0] !== "list") {
    throw new TypeError("Expected list [query] or library list [kind] [query].");
  }

  const hasKind = library && RESOURCE_KINDS.includes(rest[1]);
  return { source: library ? "library" : "core", kind: hasKind ? rest[1] : "skills", query: rest.slice(hasKind ? 2 : 1).join(" ").trim() };
}

export function formatResources(kind, resources, query = "", source = "core") {
  if (resources.length === 0) {
    return `No ${kind} match${query ? `ing ${JSON.stringify(query)}` : ""}.`;
  }
  return [
    `Useful Skills ${source === "library" ? "reference library" : "core"} ${kind} (${resources.length}):`,
    ...resources.map(resource => `  ${resource.name}${resource.description ? ` — ${resource.description}` : ""}\n    ${resource.usage}`),
  ].join("\n");
}
