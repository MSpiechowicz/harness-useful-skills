import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = path.join(ROOT, "opencode", "skills");
const AGENTS = path.join(ROOT, "opencode", "agents");
const AGENT_NAMES = ["backend", "frontend", "general-purpose", "planner", "reviewer", "scout", "security-reviewer"];

function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "file starts with a closed frontmatter block");
  return match[1].split("\n");
}

test("rendered OpenCode skills match the canonical sources", async () => {
  const { stdout } = await execute(process.execPath, [path.join(ROOT, "scripts", "render-opencode-skills.js"), "--check"]);
  assert.match(stdout, /^Checked \d+ OpenCode skill/);
});

test("every OpenCode skill has OpenCode-valid frontmatter", async () => {
  const folders = (await readdir(SKILLS, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.equal(folders.length, 21);

  for (const folder of folders) {
    const rows = frontmatterOf(await readFile(path.join(SKILLS, folder, "SKILL.md"), "utf8"));
    assert.deepEqual(rows.map(row => row.split(":")[0]), ["name", "description"], folder);
    assert.equal(rows[0], `name: ${folder}`);
    assert.match(folder, /^[a-z0-9]+(-[a-z0-9]+)*$/);

    const description = JSON.parse(rows[1].slice("description: ".length));
    assert.ok(description.length >= 1 && description.length <= 1024, `${folder} description length`);
  }
});

// Keys OpenCode v1.19 accepts under `permission:` (packages/core/src/v1/config/permission.ts) plus the "*" default.
const PERMISSION_KEYS = new Set(["*", "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill"]);
const READ_ONLY = { "*": "deny", read: "object", grep: "allow", glob: "allow", list: "allow", lsp: "allow", skill: "allow" };
const EXPECTED_PERMISSIONS = {
  scout: READ_ONLY,
  planner: READ_ONLY,
  reviewer: { ...READ_ONLY, bash: "ask" },
  "security-reviewer": { ...READ_ONLY, bash: "ask" },
  frontend: { ...READ_ONLY, edit: "allow", bash: "ask" },
  backend: { ...READ_ONLY, edit: "allow", bash: "ask" },
  "general-purpose": { ...READ_ONLY, edit: "allow", bash: "ask" },
};

// Reads the top-level rows of the permission block; a nested map is reported as "object" with its rows.
function permissionsOf(rows) {
  const start = rows.indexOf("permission:");
  assert.ok(start >= 0, "has a permission block");

  const permissions = new Map();
  const nested = new Map();
  let current;
  for (const row of rows.slice(start + 1)) {
    const top = /^  ("\*"|[a-z_]+):(?: (allow|ask|deny))?$/.exec(row);
    if (top) {
      current = top[1].replaceAll('"', "");
      assert.equal(permissions.has(current), false, `duplicate ${current}`);
      permissions.set(current, top[2] ?? "object");
      continue;
    }

    const child = /^    ("[^"]+"): (allow|ask|deny)$/.exec(row);
    assert.ok(child && current && permissions.get(current) === "object", `unexpected permission row ${row}`);
    nested.set(current, [...(nested.get(current) ?? []), [child[1].replaceAll('"', ""), child[2]]]);
  }
  return { permissions, nested };
}

test("OpenCode agent templates keep a closed frontmatter, subagent mode, and no model pin", async () => {
  for (const name of AGENT_NAMES) {
    const text = await readFile(path.join(AGENTS, `${name}.md`), "utf8");
    assert.ok(text.startsWith("---\n"), name);

    const rows = frontmatterOf(text);
    assert.ok(rows.some(row => row.startsWith("description: ")), name);
    assert.ok(rows.includes("mode: subagent"), name);
    assert.equal(rows.some(row => /^(model|variant):/.test(row)), false, name);
  }
});

test("OpenCode agent permissions are allow-lists over valid keys, denying everything else", async () => {
  assert.deepEqual([...AGENT_NAMES].sort(), Object.keys(EXPECTED_PERMISSIONS).sort());

  for (const name of AGENT_NAMES) {
    const { permissions, nested } = permissionsOf(frontmatterOf(await readFile(path.join(AGENTS, `${name}.md`), "utf8")));
    assert.equal([...permissions.keys()][0], "*", `${name} starts from the default`);
    assert.equal(permissions.get("*"), "deny", name);
    assert.deepEqual(Object.fromEntries(permissions), EXPECTED_PERMISSIONS[name], name);

    for (const key of permissions.keys()) assert.ok(PERMISSION_KEYS.has(key), `${name}: ${key} is an OpenCode permission key`);
    for (const closed of ["webfetch", "websearch", "task", "question", "todowrite", "external_directory"]) {
      assert.equal(permissions.has(closed), false, `${name} leaves ${closed} to the default deny`);
    }

    // Reading stays allowed but dotenv files keep OpenCode's default prompt.
    assert.deepEqual(nested.get("read"), [["*", "allow"], ["*.env", "ask"], ["*.env.*", "ask"], ["*.env.example", "allow"]], name);
  }
});

test("the fallback /useful-skills command never forwards arguments or runs shell output", async () => {
  const text = await readFile(path.join(ROOT, "opencode", "commands", "useful-skills.md"), "utf8");
  assert.ok(text.startsWith("---\ndescription: "));
  assert.equal(text.includes("$ARGUMENTS"), false);
  assert.equal(text.includes("!`"), false);
});
