import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REAL_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "codex", "agents");

/**
 * A fake `codex` (CLI 0.154 behaviour, as far as the installer uses it). State lives in
 * `$CODEX_HOME/fake-codex-state.json` and is mirrored to `config.toml`; every argv is appended to `$FAKE_CODEX_LOG`.
 * `FAKE_CWD_LOG` collects the working directory of each call. `FAKE_CODEX_FAIL` makes commands whose argv starts with it fail; `FAKE_CODEX_GIT_NAME` names git marketplaces.
 */
const FAKE_CODEX = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\n");
if (process.env.FAKE_CWD_LOG) fs.appendFileSync(process.env.FAKE_CWD_LOG, process.cwd() + "\n");
const fail = (message) => { process.stderr.write("WARNING: proceeding, even though we could not create PATH aliases\nError: " + message + "\n"); process.exit(1); };
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
if (args[0] === "--version") { process.stdout.write("codex-cli 0.154.0\n"); process.exit(0); }
if (process.env.FAKE_CODEX_FAIL && args.join(" ").startsWith(process.env.FAKE_CODEX_FAIL)) fail("injected failure");

const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(home)) fail("failed to resolve CODEX_HOME");
const stateFile = path.join(home, "fake-codex-state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { marketplaces: [], plugins: [], mcp: {} };
function save() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const toml = [];
  for (const m of state.marketplaces) toml.push("[marketplaces." + m.name + "]", 'source_type = "' + m.sourceType + '"', 'source = "' + m.source + '"', ...(m.ref ? ['ref = "' + m.ref + '"'] : []), "");
  for (const [name, s] of Object.entries(state.mcp)) toml.push("[mcp_servers." + name + "]", 'command = "' + s.command + '"', "");
  fs.writeFileSync(path.join(home, "config.toml"), toml.join("\n"));
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const key = args.slice(0, 3).join(" ");

if (key === "plugin marketplace list") {
  print({ marketplaces: state.marketplaces.map((m) => ({ name: m.name, root: m.source, marketplaceSource: { sourceType: m.sourceType, source: m.source } })) });
} else if (key === "plugin marketplace add") {
  const source = args[3];
  const ref = args[4] === "--ref" ? args[5] : null;
  if (source.startsWith("file://")) fail("file:// sources are not supported");
  const local = path.isAbsolute(source);
  if (local && ref) fail("--ref is only supported for git marketplace sources");
  const entry = local
    ? { name: readJson(path.join(source, ".agents/plugins/marketplace.json")).name, sourceType: "local", source, ref: null }
    : { name: process.env.FAKE_CODEX_GIT_NAME || "harness-useful-skills", sourceType: "git", source: "https://github.com/" + source + ".git", ref };
  const existing = state.marketplaces.find((m) => m.name === entry.name);
  if (existing && (existing.source !== entry.source || existing.ref !== entry.ref)) fail("marketplace " + entry.name + " is already added from a different source; remove it before adding this source");
  if (!existing) state.marketplaces.push(entry);
  save();
  process.stdout.write((existing ? "Marketplace already added" : "Added marketplace " + entry.name) + "\n");
} else if (key === "plugin marketplace remove") {
  const before = state.marketplaces.length;
  state.marketplaces = state.marketplaces.filter((m) => m.name !== args[3]);
  if (state.marketplaces.length === before) fail("marketplace " + args[3] + " is not configured or installed");
  save();
} else if (args[0] === "plugin" && args[1] === "add") {
  const [name, market] = args[2].split("@");
  const m = state.marketplaces.find((item) => item.name === market);
  if (!m || name !== "useful-skills") fail("plugin " + name + " was not found in marketplace " + market);
  const version = m.sourceType === "local" ? readJson(path.join(m.source, "plugins/codex/.codex-plugin/plugin.json")).version : (m.ref || "v0.0.0").replace(/^v/, "");
  state.plugins = state.plugins.filter((p) => p.pluginId !== args[2]).concat([{ pluginId: args[2], version, enabled: true }]);
  save();
  print({ pluginId: args[2], name, marketplaceName: market, version, installedPath: path.join(home, "plugins/cache", market, name, version), authPolicy: "ON_INSTALL" });
} else if (args[0] === "plugin" && args[1] === "list") {
  print({ installed: state.plugins.map((p) => ({ ...p, name: p.pluginId.split("@")[0], marketplaceName: p.pluginId.split("@")[1], installed: true })), available: [] });
} else if (args[0] === "plugin" && args[1] === "remove") {
  state.plugins = state.plugins.filter((p) => p.pluginId !== args[2]);
  save();
} else if (args[0] === "mcp" && args[1] === "add") {
  const env = {};
  let index = 3;
  for (; args[index] === "--env"; index += 2) { const [k, ...v] = args[index + 1].split("="); env[k] = v.join("="); }
  if (args[index] !== "--") fail("expected --");
  state.mcp[args[2]] = { command: args[index + 1], args: args.slice(index + 2), env, enabled: true };
  save();
} else if (args[0] === "mcp" && args[1] === "get") {
  const s = state.mcp[args[2]];
  if (!s) fail("No MCP server named '" + args[2] + "' found.");
  print({ name: args[2], enabled: s.enabled, transport: { type: s.type || "stdio", command: s.command, args: s.args, env: Object.keys(s.env).length ? s.env : null, env_vars: [], cwd: null } });
} else if (args[0] === "mcp" && args[1] === "remove") {
  delete state.mcp[args[2]];
  save();
} else {
  fail("unexpected arguments " + args.join(" "));
}
`;

/** A fake `git` for `git ls-remote --tags URL refs/tags/<tag>`: lists the tags in FAKE_GIT_TAGS; FAKE_GIT_FAIL makes it fail like an offline git. */
const FAKE_GIT = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_GIT_LOG) fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT }) + "\n");
if (process.env.FAKE_CWD_LOG) fs.appendFileSync(process.env.FAKE_CWD_LOG, process.cwd() + "\n");
if (process.env.FAKE_GIT_FAIL) { process.stderr.write("fatal: unable to access 'https://github.com/': Could not resolve host: github.com\n"); process.exit(128); }
if (args[0] !== "ls-remote" || args[1] !== "--tags") { process.stderr.write("unexpected git arguments\n"); process.exit(2); }
const wanted = args[3];
for (const tag of (process.env.FAKE_GIT_TAGS || "").split(",").filter(Boolean)) {
  if ("refs/tags/" + tag === wanted) process.stdout.write("0123456789abcdef0123456789abcdef01234567\trefs/tags/" + tag + "\n");
}
`;

/** Temp HOME, CODEX_HOME (created), a bin directory holding the fake `codex` and `git`, and logs of their calls. */
export function createCodexSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "us-codex-install-"));
  const bin = path.join(root, "bin");
  const codexHome = path.join(root, "codex-home");
  mkdirSync(bin);
  mkdirSync(codexHome);
  mkdirSync(path.join(root, "home"));
  for (const [name, script] of [["codex", FAKE_CODEX], ["git", FAKE_GIT]]) {
    writeFileSync(path.join(bin, name), `#!${process.execPath}\n${script}`);
    chmodSync(path.join(bin, name), 0o755);
  }

  const log = path.join(root, "codex-calls.jsonl");
  const gitLog = path.join(root, "git-calls.jsonl");
  const environment = { HOME: path.join(root, "home"), CODEX_HOME: codexHome, PATH: bin, FAKE_CODEX_LOG: log, FAKE_GIT_LOG: gitLog, FAKE_GIT_TAGS: "v0.3.11,v0.3.12" };
  const stateFile = path.join(codexHome, "fake-codex-state.json");
  return {
    root,
    bin,
    codexHome,
    environment,
    packageRoot: path.join(root, "package"),
    at: (...parts) => path.join(codexHome, ...parts),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    clearCalls: () => rmSync(log, { force: true }),
    gitCalls: () => (existsSync(gitLog) ? readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    state: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { marketplaces: [], plugins: [], mcp: {} }),
    setState: (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A small package root: the plugin manifest, the marketplace manifest, and a runtime bundle with the real agent files.
 * `files` adds or overrides runtime files (a null value drops one).
 */
export function writePackage(packageRoot, { version = "0.3.11", marketplace = "harness-useful-skills", files = {} } = {}) {
  rmSync(packageRoot, { recursive: true, force: true });
  const runtime = path.join(packageRoot, "plugins", "codex-runtime", "useful-skills");
  mkdirSync(path.join(runtime, "codex"), { recursive: true });
  cpSync(REAL_AGENTS, path.join(runtime, "codex", "agents"), { recursive: true });

  const content = {
    "package.json": `${JSON.stringify({ name: "useful-skills-codex-runtime", private: true, type: "module" })}\n`,
    "codex/mcp-server.js": `// mcp ${version}\n`,
    "codex/host-context.js": "export {};\n",
    "memory.js": `// memory ${version}\n`,
    ...files,
  };
  for (const [rel, text] of Object.entries(content)) {
    if (text === null) continue;
    const target = path.join(runtime, ...rel.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  const manifest = path.join(packageRoot, "plugins", "codex", ".codex-plugin", "plugin.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify({ name: "useful-skills", version })}\n`);
  const market = path.join(packageRoot, ".agents", "plugins", "marketplace.json");
  mkdirSync(path.dirname(market), { recursive: true });
  writeFileSync(market, `${JSON.stringify({ name: marketplace, plugins: [] })}\n`);
}

/** Every file and directory under `directory` except the fake's own state and config, relative and sorted. */
export function listTree(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true }).filter((rel) => !["fake-codex-state.json", "config.toml"].includes(rel)).sort();
}
