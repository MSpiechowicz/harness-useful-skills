import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export async function readUpstreamProvenance({ root = PACKAGE_ROOT } = {}) {
  const provenance = JSON.parse(await readFile(path.join(root, "ecc-upstream.json"), "utf8"));
  if (provenance.repository !== "affaan-m/ECC" || !/^[a-f0-9]{40}$/.test(provenance.revision)) {
    throw new Error("Invalid ECC upstream provenance.");
  }
  return provenance;
}

export const PORTABLE_RULE_FILES = Object.freeze([
  "coding-style.md",
  "testing.md",
  "security.md",
  "git-workflow.md",
  "patterns.md",
  "development-workflow.md",
  "code-review.md",
]);

const MAX_RULE_BYTES = 32 * 1024;
const DISABLED_VALUES = new Set(["0", "false", "off", "none", "disabled"]);
const SECRET_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(\bBearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|password|passwd|secret)\b\s*[:=]\s*["']?)[^\s"'`]{8,}/gi,
];
const DANGEROUS_COMMANDS = [
  {
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*|--recursive)(?:\s+[^;&|]*\/(?:\s|$)|\s+~(?:\/|\s|$)|\s+\$HOME(?:\/|\s|$)|\s+\.?(?:\/)?\.?(?:\s|$))/i,
    reason: "blocked recursive deletion of a root, home, or current directory",
  },
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
  if (!value) return undefined;
  const quoted = /^("|')(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function walkMarkdown(root) {
  const output = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(file);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

export function safetyEnabled(environment = process.env) {
  return !isDisabled(environment.OMP_ECC_SAFETY ?? environment.ECC_OMP_SAFETY);
}

export function dangerousCommandReason(command) {
  if (typeof command !== "string" || !command.trim()) return undefined;
  return DANGEROUS_COMMANDS.find(({ pattern }) => pattern.test(command))?.reason;
}

export function redactText(value) {
  if (typeof value !== "string" || !value) return value;
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

export function redactToolResultContent(content) {
  if (!Array.isArray(content)) return undefined;
  let changed = false;
  const redacted = content.map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") return block;
    const text = redactText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? redacted : undefined;
}

export async function loadPortableRules({ root = PACKAGE_ROOT, files = PORTABLE_RULE_FILES } = {}) {
  const sections = [];
  const ompPolicy = (await readOptional(path.join(root, "rules", "omp", "oh-my-pi.md")))?.trim();
  let total = ompPolicy?.length ?? 0;
  for (const file of files) {
    const contents = (await readOptional(path.join(root, "rules", "common", file)))?.trim();
    if (!contents || total + contents.length > MAX_RULE_BYTES) break;
    total += contents.length;
    sections.push(contents);
  }
  if (ompPolicy) sections.push(ompPolicy);
  if (!sections.length) return undefined;
  return `<ecc-omp-engineering-rules>\n${sections.join("\n\n---\n\n")}\n</ecc-omp-engineering-rules>`;
}

export async function resourceInventory({ root = PACKAGE_ROOT } = {}) {
  const skillsRoot = path.join(root, "skills");
  let skillEntries = [];
  try {
    skillEntries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    skillEntries = [];
  }
  const skills = await Promise.all(skillEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => (await readOptional(path.join(skillsRoot, entry.name, "SKILL.md")) ? 1 : 0)));
  const countFiles = async (directory, recursive = false) => {
    if (!recursive) {
      try {
        return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
      } catch {
        return 0;
      }
    }
    return (await walkMarkdown(directory)).length;
  };
  const [commands, agents, rules] = await Promise.all([
    countFiles(path.join(root, "commands")),
    countFiles(path.join(root, "agents")),
    countFiles(path.join(root, "rules"), true),
  ]);
  return { skills: skills.reduce((sum, value) => sum + value, 0), commands, agents, rules };
}

export async function listResources(kind, { root = PACKAGE_ROOT, query = "" } = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  const matches = (item) => !normalizedQuery || `${item.name} ${item.description ?? ""} ${item.path ?? ""}`.toLowerCase().includes(normalizedQuery);
  if (kind === "skills") {
    const inventory = [];
    let entries = [];
    try {
      entries = await readdir(path.join(root, "skills"), { withFileTypes: true });
    } catch {
      return inventory;
    }
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const file = path.join(root, "skills", entry.name, "SKILL.md");
      const contents = await readOptional(file);
      if (!contents) continue;
      const name = frontmatterField(contents, "name") ?? entry.name;
      const description = frontmatterField(contents, "description") ?? "";
      const item = { name, description, path: path.relative(root, file), usage: `/skill:${name}` };
      if (matches(item)) inventory.push(item);
    }
    return inventory.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (kind === "commands" || kind === "agents") {
    const directory = path.join(root, kind);
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const items = [];
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))) {
      const file = path.join(directory, entry.name);
      const contents = await readFile(file, "utf8");
      const baseName = entry.name.slice(0, -3);
      const name = frontmatterField(contents, "name") ?? baseName;
      const description = frontmatterField(contents, "description") ?? "";
      const item = { name, description, path: path.relative(root, file), usage: kind === "commands" ? `/${baseName}` : `agent:${baseName}` };
      if (matches(item)) items.push(item);
    }
    return items.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (kind === "rules") {
    return (await walkMarkdown(path.join(root, "rules")))
      .map((file) => ({ name: path.basename(file, ".md"), description: "", path: path.relative(root, file), usage: path.relative(root, file) }))
      .filter(matches);
  }
  throw new TypeError("Resource kind must be skills, commands, agents, or rules.");
}
