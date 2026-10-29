import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../claude/command.js";
import { workspaceMemoryPaths } from "../../memory-paths.js";

export const SECRET = `token=${"x".repeat(25)}`;

/** Fake services: the code graph probe answers from `codeGraph` and counts its calls; nothing else is installed or built. */
function fakeServices({ codeGraph = "available" } = {}) {
  const calls = { probe: 0 };
  const outcomes = {
    available: { outcome: "available", state: "ok" },
    old: { outcome: "not available", state: "ok", detail: "update Harness Memory for the code index" },
    missing: { outcome: "harness-memory not found", state: "ok", detail: "install Harness Memory for the code_map, code_symbol, code_impact and code_path tools" },
  };

  const services = {
    probeCodeGraph: async () => {
      calls.probe++;
      return outcomes[codeGraph];
    },
  };

  return { calls, services };
}

export async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-claude-doctor-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = path.join(root, "claude");
  const packageRoot = path.join(configDir, "plugins", "cache", "harness-useful-skills", "harness-useful-skills", "0.2.31");
  const dataDir = path.join(configDir, "plugins", "data", "harness-useful-skills-harness-useful-skills");
  const repo = path.join(root, "repo");
  await mkdir(path.join(packageRoot, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(packageRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "harness-useful-skills" }));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await writeFile(path.join(repo, "main.py"), "def main(): pass\n");

  const fake = fakeServices(options);
  const run = (argv, { environment = {}, project = repo, services = fake.services, packageRoot: pluginRoot = packageRoot, doctorBudgetMs } = {}) => runCommand(argv, {
    environment: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: project, ...environment },
    cwd: root,
    packageRoot: pluginRoot,
    doctorServices: services,
    ...(doctorBudgetMs ? { doctorBudgetMs } : {}),
  });

  return { root, configDir, packageRoot, dataDir, repo, calls: fake.calls, services: fake.services, run };
}

export async function factsDirectory(f, project = f.repo) {
  const paths = await workspaceMemoryPaths({ cwd: project, agentDir: f.dataDir });
  return path.join(paths.directory, "claude-facts");
}

export function assertNoWrites(f) {
  return Promise.all([
    readdir(f.dataDir).then(entries => assert.deepEqual(entries, [])),
    readdir(f.configDir).then(entries => assert.deepEqual(entries, ["plugins"])),
  ]);
}

/**
 * Mimic `claude plugin marketplace add <repo>` + `plugin install harness-useful-skills@<marketplace>`: the plugin
 * runs from the repo folder and Claude records the install in its plugins state files.
 */
export async function directoryMarketplace(f, { marketplaces = ["harness-useful-skills"], installed = marketplaces, source = "." } = {}) {
  const pluginRepo = path.join(f.root, "plugin-repo");
  await mkdir(path.join(pluginRepo, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(pluginRepo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "harness-useful-skills" }));
  await writeFile(path.join(pluginRepo, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "harness-useful-skills",
    plugins: [{ name: "harness-useful-skills", source }],
  }));

  const pluginsDir = path.join(f.configDir, "plugins");
  const known = Object.fromEntries(marketplaces.map(marketplace => [marketplace, {
    source: { source: "directory", path: pluginRepo },
    installLocation: pluginRepo,
    lastUpdated: "2026-10-08T00:00:00.000Z",
  }]));
  const plugins = Object.fromEntries(installed.map(marketplace => [`harness-useful-skills@${marketplace}`, [{
    scope: "user",
    installPath: path.join(pluginsDir, "cache", marketplace, "harness-useful-skills", "ce05208f1c5b"),
    version: "ce05208f1c5b",
  }]]));
  await writeFile(path.join(pluginsDir, "known_marketplaces.json"), JSON.stringify(known));
  await writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));

  return pluginRepo;
}
