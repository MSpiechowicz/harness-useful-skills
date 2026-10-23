import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = path.join(ROOT, "codex", "skills");
const RENDERER = path.join(ROOT, "scripts", "render-codex-skills.js");

function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "file starts with a closed frontmatter block");
  return match[1].split("\n");
}

test("rendered Codex skills match the canonical sources", async () => {
  const { stdout } = await execute(process.execPath, [RENDERER, "--check"]);
  assert.match(stdout, /^Checked \d+ Codex skill/);
});

test("every Codex skill has only name and description in its frontmatter", async () => {
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

test("Codex skills name Codex tools and carry no other host's wording", async () => {
  const workflow = await readFile(path.join(SKILLS, "us-run-workflow", "SKILL.md"), "utf8");
  assert.match(workflow, /^## Native model routing$/m);
  assert.match(workflow, /`spawn_agent`/);
  assert.match(workflow, /`wait_agent`/);
  assert.match(workflow, /`explorer`/);

  const memory = await readFile(path.join(SKILLS, "us-manage-memory", "SKILL.md"), "utf8");
  assert.match(memory, /`harness-useful-skills` MCP server/);
  for (const tool of ["memory_status", "memory_search", "memory_save", "graph_build", "graph_query"]) {
    assert.ok(memory.includes(`\`${tool}\``), tool);
  }

  const files = (await readdir(SKILLS, { recursive: true })).filter(file => file.endsWith(".md"));
  assert.ok(files.length >= 26);
  for (const file of files) {
    const text = await readFile(path.join(SKILLS, file), "utf8");
    assert.doesNotMatch(text, /skill:\/\/|\/skill:|CLAUDE_PLUGIN_ROOT|AskUserQuestion|\bOMP\b|\bOpenCode\b|us_memory|subagent_type|todowrite|(?<!\.)\/useful-skills/, file);
  }
});
