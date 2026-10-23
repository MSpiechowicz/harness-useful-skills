import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The names used before the rename: the plugin and its skill namespace, the MCP server and tool prefix, the Claude marketplace, and plugin IDs.
const OLD_NAMES = [
  /useful_skills/,
  /(?<!harness-)useful-skills:/,
  /useful-skills-local/,
  /(?<![\w-])useful-skills@/,
];

// Only migration code may mention them: the names live in legacy-names.js, the README explains the upgrade, the
// `useful-skills` script is the unchanged command line tool, and tests describe the old state they migrate from.
const ALLOWED = [
  /(^|\/)legacy-names\.js$/,
  /^README\.md$/,
  /^useful-skills$/,
  /^test\//,
];

function shippedFiles() {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  return listed.split("\0").filter(Boolean);
}

test("no shipped file mentions a name from before the rename outside migration code", () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    if (ALLOWED.some(pattern => pattern.test(file))) continue;

    let data;
    try {
      data = readFileSync(path.join(ROOT, file));
    } catch {
      continue;
    }
    if (data.includes(0)) continue;

    const text = data.toString("utf8");
    for (const pattern of OLD_NAMES) {
      const match = pattern.exec(text);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("the bundles that ship the host adapters carry the legacy names only in legacy-names.js", () => {
  const holders = shippedFiles().filter(file => /^plugins\//.test(file) && !file.endsWith("/README.md"))
    .filter(file => {
      try {
        const text = readFileSync(path.join(ROOT, file), "utf8");
        return OLD_NAMES.some(pattern => pattern.test(text));
      } catch {
        return false;
      }
    });

  assert.ok(holders.length > 0, "the bundles should contain legacy-names.js");
  assert.ok(holders.every(file => file.endsWith("/legacy-names.js")), holders.join(", "));
});

test("the plugin, marketplace and MCP server carry the unified name on every host", () => {
  const read = file => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  const claudePlugin = read(".claude-plugin/plugin.json");
  const claudeMarketplace = read(".claude-plugin/marketplace.json");
  const codexMarketplace = read(".agents/plugins/marketplace.json");

  assert.equal(claudePlugin.name, "harness-useful-skills");
  assert.deepEqual(Object.keys(claudePlugin.mcpServers), ["harness-useful-skills"]);
  assert.equal(claudeMarketplace.name, "harness-useful-skills");
  assert.deepEqual(claudeMarketplace.plugins.map(plugin => plugin.name), ["harness-useful-skills"]);
  assert.equal(read("codex/plugin.json").name, "harness-useful-skills");
  assert.equal(codexMarketplace.name, "harness-useful-skills");
  assert.deepEqual(codexMarketplace.plugins.map(plugin => plugin.name), ["harness-useful-skills"]);
  assert.equal(read("opencode/package.json").name, "harness-useful-skills-opencode");
  assert.equal(read("plugins/claude/.claude-plugin/plugin.json").name, "harness-useful-skills");
});

test("skills name their tools and namespace with the unified name", () => {
  const skill = (host, name) => readFileSync(path.join(ROOT, host, "skills", name, "SKILL.md"), "utf8");

  assert.match(skill("claude", "us-run-workflow"), /`harness-useful-skills:planner`/);
  assert.match(skill("claude", "us-manage-memory"), /MCP server `harness-useful-skills`/);
  assert.match(skill("opencode", "us-manage-memory"), /`harness-useful-skills_memory_status`/);
  assert.match(skill("opencode", "us-manage-memory"), /`harness-useful-skills_graph_query`/);
  assert.match(skill("codex", "us-manage-memory"), /`harness-useful-skills` MCP server/);
});
