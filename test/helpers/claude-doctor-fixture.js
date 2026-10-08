import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../claude/command.js";
import { runClaudeDoctor } from "../../claude/doctor-setup.js";
import { resolveHostContext } from "../../claude/host-context.js";
import { workspaceMemoryPaths } from "../../graphify.js";
import { extract, service, validGraph } from "./graph-fixture.js";

export const SECRET = `token=${"x".repeat(25)}`;
export const HOME_BLOCKED = "project's Git work tree includes the home directory or is the filesystem root";

/** Fake dependency runtime: missing until installed, with call counters for install and Graphify extraction. */
function fakeServices({ installError, buildError, dependencyState = "missing" } = {}) {
  const calls = { install: 0, build: 0 };
  let installed = false;

  const services = {
    dependencyStatus: async () => {
      if (installed) {
        return { ready: true, state: "ready" };
      }

      return { ready: false, state: dependencyState, reason: "Platform is unsupported" };
    },
    ensureDependencies: async ({ signal } = {}) => {
      calls.install++;
      if (installError === "wait") {
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("Managed Graphify setup was cancelled.");
      }

      if (installError) {
        throw new Error(installError);
      }

      installed = true;
      return { python: "/managed/python", version: "0.9.65" };
    },
    graphify: service({
      runProcess: async (_file, args) => {
        calls.build++;
        if (buildError) {
          throw new Error(buildError);
        }

        return extract(args, validGraph);
      },
    }),
  };

  return { calls, services };
}

export async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-claude-doctor-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = path.join(root, "claude");
  const packageRoot = path.join(configDir, "plugins", "cache", "useful-skills-local", "useful-skills", "0.2.31");
  const dataDir = path.join(configDir, "plugins", "data", "useful-skills-useful-skills-local");
  const repo = path.join(root, "repo");
  await mkdir(path.join(packageRoot, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(packageRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "useful-skills" }));
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

/** A dotfiles-style home directory that is itself a Git work tree. */
export async function gitHome(f) {
  const home = path.join(f.root, "real-home");
  await mkdir(path.join(home, ".git"), { recursive: true });
  return home;
}

export async function graphOutcome(f, workspace, system) {
  const host = await resolveHostContext({ workspace, data: f.dataDir });
  const outcome = await runClaudeDoctor({ ...host, services: f.services, system });
  return outcome.steps.at(-1);
}

/**
 * Mimic `claude plugin marketplace add <repo>` + `plugin install useful-skills@<marketplace>`: the plugin
 * runs from the repo folder and Claude records the install in its plugins state files.
 */
export async function directoryMarketplace(f, { marketplaces = ["useful-skills-local"], installed = marketplaces, source = "." } = {}) {
  const pluginRepo = path.join(f.root, "plugin-repo");
  await mkdir(path.join(pluginRepo, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(pluginRepo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "useful-skills" }));
  await writeFile(path.join(pluginRepo, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "useful-skills-local",
    plugins: [{ name: "useful-skills", source }],
  }));

  const pluginsDir = path.join(f.configDir, "plugins");
  const known = Object.fromEntries(marketplaces.map(marketplace => [marketplace, {
    source: { source: "directory", path: pluginRepo },
    installLocation: pluginRepo,
    lastUpdated: "2026-10-08T00:00:00.000Z",
  }]));
  const plugins = Object.fromEntries(installed.map(marketplace => [`useful-skills@${marketplace}`, [{
    scope: "user",
    installPath: path.join(pluginsDir, "cache", marketplace, "useful-skills", "ce05208f1c5b"),
    version: "ce05208f1c5b",
  }]]));
  await writeFile(path.join(pluginsDir, "known_marketplaces.json"), JSON.stringify(known));
  await writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));

  return pluginRepo;
}
