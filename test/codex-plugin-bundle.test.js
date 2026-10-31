import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = path.join(ROOT, "plugins", "codex");
const RUNTIME = path.join(ROOT, "plugins", "codex-runtime", "harness-useful-skills");
const BUILD = path.join(ROOT, "scripts", "build-codex-plugin.js");
// Matched against paths relative to either bundle.
const FORBIDDEN = [
  /^(claude|opencode|omp|pi|hooks|test|scripts|docs)(\/|$)/,
  /^extension\.js$/,
  /^updater\.js$/,
  /^useful-skills$/,
  /^release\.py$/,
  /(^|\/)\.(omp|claude)-plugin(\/|$)/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)hooks(\/|\.json$)/,
  /\.test\.(js|ts)$/,
  /(^|\/)skills\/us-library(\/|$)/,
  /(^|\/)references\/ecc(\/|$)/,
];
const REFERENCE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']|new URL\(\s*["'](\.?\.?\/?[^"':]+)["']\s*,\s*import\.meta\.url/g;
const AGENTS = ["backend", "frontend", "general-purpose", "planner", "release-assessor", "reviewer", "scout", "security-reviewer"];

async function filesBelow(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await filesBelow(path.join(directory, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function isolated(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-codex-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !name.startsWith("CODEX")));
  const data = path.join(root, "useful-skills-data");
  const cwd = path.join(root, "workspace");
  await mkdir(data);
  await mkdir(cwd);
  await writeFile(path.join(cwd, "README.md"), "# workspace\n");
  return { cwd, env: { ...env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), USEFUL_SKILLS_DATA: data } };
}

test("the committed Codex bundles match their generator", async () => {
  const { stdout } = await execute(process.execPath, [BUILD, "--check"], { cwd: ROOT });
  assert.match(stdout, /Checked \d+ Codex plugin bundle files/);
  assert.match(stdout, /Checked \d+ Codex runtime bundle files/);
});

test("the plugin ships the manifest, the 22 canonical skills, and no MCP config or hooks", async () => {
  const files = await filesBelow(PLUGIN);
  assert.deepEqual(files.filter(file => FORBIDDEN.some(pattern => pattern.test(file))), []);
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes(".codex-plugin/plugin.json"));
  assert.ok(files.includes("LICENSE"));

  const canonical = (await readdir(path.join(ROOT, "skills"), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("us-")).map(entry => entry.name).sort();
  const skills = (await readdir(path.join(PLUGIN, "skills"))).sort();
  assert.equal(skills.length, 22);
  assert.deepEqual(skills, canonical);
  for (const skill of skills) assert.ok(await exists(path.join(PLUGIN, "skills", skill, "SKILL.md")), skill);
});

test("the manifest carries the package version and points at the skills folder", async () => {
  const expected = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
  const source = JSON.parse(await readFile(path.join(ROOT, "codex", "plugin.json"), "utf8"));
  const bundled = JSON.parse(await readFile(path.join(PLUGIN, ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(bundled, source);
  assert.equal(bundled.version, expected);
  assert.equal(bundled.name, "harness-useful-skills");
  assert.equal(bundled.skills, "./skills/");
  assert.equal(bundled.license, "GPL-3.0-only");
  assert.equal("mcpServers" in bundled, false);
  assert.equal("hooks" in bundled, false);
});

test("the runtime holds the memory server closure and the agents, with no other host", async () => {
  const files = await filesBelow(RUNTIME);
  // apply-models.js shares the installer's file helpers, which live in opencode/: nothing else from that host belongs here.
  assert.deepEqual(files.filter(file => file.startsWith("opencode/")).sort(), ["opencode/install-files.js", "opencode/paths.js"]);
  assert.deepEqual(files.filter(file => !file.startsWith("opencode/") && FORBIDDEN.some(pattern => pattern.test(file))), []);
  assert.deepEqual(files.filter(file => file.startsWith("codex/agents/")).sort(), AGENTS.map(name => `codex/agents/${name}.toml`));
  assert.ok(files.includes("codex/mcp-server.js"));
  assert.ok(!files.some(file => /^(skills|codex\/skills)(\/|$)/.test(file)));
  assert.deepEqual(JSON.parse(await readFile(path.join(RUNTIME, "package.json"), "utf8")), { name: "harness-useful-skills-codex-runtime", private: true, type: "module" });
});

test("every relative import and URL in the runtime modules resolves inside the runtime", async () => {
  const modules = (await filesBelow(RUNTIME)).filter(file => file.endsWith(".js"));
  assert.ok(modules.length > 15);

  for (const file of modules) {
    const text = await readFile(path.join(RUNTIME, file), "utf8");
    for (const match of text.matchAll(REFERENCE)) {
      const target = path.resolve(RUNTIME, path.dirname(file), match[1] ?? match[2]);
      assert.ok(!path.relative(RUNTIME, target).startsWith(".."), `${file} -> ${match[1] ?? match[2]} leaves the runtime`);
      assert.ok(await exists(target), `${file} -> ${match[1] ?? match[2]} is missing`);
    }
  }
});

test("the bundled memory MCP server answers initialize and lists its five tools", async t => {
  const { cwd, env } = await isolated(t);
  const child = spawn(process.execPath, [path.join(RUNTIME, "codex", "mcp-server.js")], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const replies = new Map();
  const waiting = new Map();
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      replies.set(message.id, message);
      waiting.get(message.id)?.(message);
    }
  });
  const request = (id, method, params) => {
    const reply = new Promise(resolve => (replies.has(id) ? resolve(replies.get(id)) : waiting.set(id, resolve)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  };

  const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request(2, "tools/list");
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["memory_status", "memory_search", "memory_save"]);
  child.stdin.end();
});

test("the marketplace lists the plugin by its exact identifiers and the source path exists", async () => {
  const marketplace = JSON.parse(await readFile(path.join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.deepEqual(marketplace, {
    name: "harness-useful-skills",
    interface: { displayName: "Harness Skills" },
    plugins: [{
      name: "harness-useful-skills",
      source: { source: "local", path: "./plugins/codex" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  });
  const source = path.resolve(ROOT, marketplace.plugins[0].source.path);
  assert.equal(source, PLUGIN);
  assert.ok(await exists(path.join(source, ".codex-plugin", "plugin.json")));
});
