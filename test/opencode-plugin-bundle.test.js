import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = path.join(ROOT, "plugins", "opencode");
const RUNTIME = path.join(BUNDLE, "useful-skills");
const BUILD = path.join(ROOT, "scripts", "build-opencode-plugin.js");
// Matched against paths relative to the runtime tree.
const FORBIDDEN = [
  /^(claude|omp|hooks|test|scripts|docs)(\/|$)/,
  /^extension\.js$/,
  /^updater\.js$/,
  /^useful-skills$/,
  /^release\.py$/,
  /(^|\/)\.(omp|claude)-plugin(\/|$)/,
  /^opencode\/(install|uninstall)\.js$/,
  /\.test\.(js|ts)$/,
  /(^|\/)skills\/us-library(\/|$)/,
  /(^|\/)references\/ecc(\/|$)/,
];
const REFERENCE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']|new URL\(\s*["'](\.?\.?\/?[^"':]+)["']\s*,\s*import\.meta\.url/g;

async function bundleFiles(directory = BUNDLE, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await bundleFiles(path.join(directory, entry.name), relative));
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !name.startsWith("OPENCODE")));
  return {
    cwd: root,
    env: {
      ...env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      USEFUL_SKILLS_DATA: path.join(root, "useful-skills-data"),
    },
  };
}

test("the committed OpenCode plugin bundle matches its generator", async () => {
  const { stdout } = await execute(process.execPath, [BUILD, "--check"], { cwd: ROOT });
  assert.match(stdout, /Checked \d+ OpenCode plugin bundle files/);
});

test("the bundle excludes other hosts, the launcher, install-time modules, and test files", async () => {
  const files = await bundleFiles();
  const inside = files.filter(file => file.startsWith("useful-skills/")).map(file => file.slice("useful-skills/".length));
  assert.deepEqual(files.filter(file => !file.startsWith("useful-skills/")).sort(), ["README.md", "useful-skills.js"]);
  assert.deepEqual(inside.filter(file => FORBIDDEN.some(pattern => pattern.test(file))), []);
});

test("the entry re-exports the plugin definition from the runtime tree", async () => {
  assert.equal(await readFile(path.join(BUNDLE, "useful-skills.js"), "utf8"), 'export { default } from "./useful-skills/opencode/entry.js";\n');
});

test("the runtime manifest carries the package version", async () => {
  const expected = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
  const source = JSON.parse(await readFile(path.join(ROOT, "opencode", "package.json"), "utf8"));
  const bundled = JSON.parse(await readFile(path.join(RUNTIME, "package.json"), "utf8"));
  assert.equal(bundled.version, expected);
  assert.deepEqual(bundled, source);
  assert.equal(bundled.type, "module");
});

test("the bundle ships the 21 canonical skills, 7 agent templates and 2 commands", async () => {
  const canonical = (await readdir(path.join(ROOT, "skills"), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("us-")).map(entry => entry.name).sort();
  const skills = (await readdir(path.join(RUNTIME, "opencode", "skills"))).sort();
  assert.equal(skills.length, 21);
  assert.deepEqual(skills, canonical);
  for (const skill of skills) assert.ok(await exists(path.join(RUNTIME, "opencode", "skills", skill, "SKILL.md")), skill);

  const agents = await readdir(path.join(RUNTIME, "opencode", "agents"));
  assert.deepEqual(agents.sort(), ["backend", "frontend", "general-purpose", "planner", "reviewer", "scout", "security-reviewer"].map(name => `${name}.md`));
  assert.deepEqual((await readdir(path.join(RUNTIME, "opencode", "commands"))).sort(), ["us-ignore-workflow.md", "useful-skills.md"]);
});

test("every relative import and URL in the bundled modules resolves inside the bundle", async () => {
  const modules = (await bundleFiles()).filter(file => file.endsWith(".js"));
  assert.ok(modules.length > 20);

  for (const file of modules) {
    const text = await readFile(path.join(BUNDLE, file), "utf8");
    for (const match of text.matchAll(REFERENCE)) {
      const target = path.resolve(BUNDLE, path.dirname(file), match[1] ?? match[2]);
      assert.ok(!path.relative(BUNDLE, target).startsWith(".."), `${file} -> ${match[1] ?? match[2]} leaves the bundle`);
      assert.ok(await exists(target), `${file} -> ${match[1] ?? match[2]} is missing`);
    }
  }
});

test("the entry module carries one definition both OpenCode plugin APIs accept when imported under Node", async () => {
  const entry = await import(pathToFileURL(path.join(BUNDLE, "useful-skills.js")).href);
  assert.deepEqual(Object.keys(entry), ["default"]);
  assert.deepEqual(Object.keys(entry.default).sort(), ["id", "server", "setup"]);
  assert.equal(typeof entry.default.id, "string");
  assert.equal(typeof entry.default.server, "function");
  assert.equal(typeof entry.default.setup, "function");
});

test("the bundled command lists the 21 shipped skills", async t => {
  const { cwd, env } = await isolated(t);
  const result = await execute(process.execPath, [path.join(RUNTIME, "opencode", "command.js"), "list"], { cwd, env });
  const names = [...result.stdout.matchAll(/^\s+(us-[a-z-]+)/gm)].map(match => match[1]);
  assert.equal(names.length, 21);
  assert.ok(!names.includes("us-library"));
});

test("the bundled memory MCP server answers initialize and lists its five tools", async t => {
  const { cwd, env } = await isolated(t);
  const child = spawn(process.execPath, [path.join(RUNTIME, "opencode", "mcp-server.js")], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
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
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["memory_status", "memory_search", "memory_save", "graph_build", "graph_query"]);
  child.stdin.end();
});
