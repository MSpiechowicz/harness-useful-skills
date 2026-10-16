import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runCommand } from "../opencode/command.js";
import { fastLaneContext, workflowContext } from "../opencode/context.js";
import { runHookCli } from "../opencode/hook-cli.js";
import { installRecordPath, RUNTIME_ROOT } from "../opencode/paths.js";
import { effectiveWorkflow } from "../workflow-policy.js";

const execute = promisify(execFile);
const HOOK_CLI = fileURLToPath(new URL("../opencode/hook-cli.js", import.meta.url));

/** A temp HOME with XDG dirs and a Git repository; never the real user dirs. */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-hook-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const environment = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
  };
  const configDir = path.join(environment.XDG_CONFIG_HOME, "opencode");
  const repo = path.join(root, "repo");
  for (const directory of [environment.HOME, configDir, path.join(repo, ".git")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  return { root, environment, configDir, repo };
}

async function hookCli(f, args) {
  const { stdout } = await execute(process.execPath, [HOOK_CLI, ...args], { cwd: f.repo, env: f.environment });
  const lines = stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one JSON line");
  return JSON.parse(lines[0]).text;
}

/** The policy of saved settings where every stage is enabled and the workflow is as given. */
function policy(workflow) {
  const stages = { research: true, plan: true, review: true, "security-review": true, "backend-memory": true, "graphify-memory": true };
  return effectiveWorkflow({ values: { workflow, ...stages }, errors: {} });
}

test("context prints the workflow guidance for the session repository's saved settings", async t => {
  const f = await fixture(t);
  assert.equal(await hookCli(f, ["context"]), workflowContext(policy(true)));
  assert.equal(await hookCli(f, ["context", "--opt-out"]), fastLaneContext());

  const saved = await runCommand(["workflow disabled"], { environment: f.environment, cwd: f.repo });
  assert.equal(saved.exitCode, 0, saved.text);
  assert.equal(await hookCli(f, ["context"]), workflowContext(policy(false)));
  assert.notEqual(workflowContext(policy(false)), workflowContext(policy(true)));
});

test("context treats a missing OpenCode config dir as no saved settings", async t => {
  const f = await fixture(t);
  await rm(f.environment.XDG_CONFIG_HOME, { recursive: true, force: true });
  assert.equal(await hookCli(f, ["context"]), workflowContext(policy(true)));
  assert.equal(await hookCli(f, ["context", "--opt-out"]), fastLaneContext());
});

test("unknown subcommands and arguments fail with exit 2 and nothing on stdout", async t => {
  const f = await fixture(t);
  for (const args of [[], ["bogus"], ["context", "--other"], ["sync-agents", "extra"]]) {
    const failure = await execute(process.execPath, [HOOK_CLI, ...args], { cwd: f.repo, env: f.environment }).then(() => undefined, error => error);
    assert.equal(failure?.code, 2, JSON.stringify(args));
    assert.equal(failure.stdout, "");
  }
});

test("sync-agents is a no-op outside an install and regenerates the recorded install's agents", async t => {
  const f = await fixture(t);
  assert.deepEqual(await runHookCli(["sync-agents"], { environment: f.environment, cwd: f.repo, runtimeRoot: RUNTIME_ROOT }), { text: "", exitCode: 0 });
  assert.equal(await hookCli(f, ["sync-agents"]), "", "a checkout runtime has no install record");

  const scopeRoot = f.configDir;
  const runtimeRoot = path.join(scopeRoot, "plugins", "useful-skills");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(installRecordPath(scopeRoot), JSON.stringify({
    schema: 1, version: "1.0.0", scope: "user", scopeRoot, dataDir: path.join(f.root, "data"), configFile: null, mcpEntry: null, files: {},
  }));

  const { text, exitCode } = await runHookCli(["sync-agents"], { environment: f.environment, cwd: f.repo, runtimeRoot });
  assert.equal(exitCode, 0);
  assert.match(text, /`us-backend`: inherits the session model/);
  assert.ok((await readdir(path.join(scopeRoot, "agents"))).includes("us-backend.md"));
});

test("update-check reports only a newer release and stays quiet on failure", async t => {
  const f = await fixture(t);
  const run = checkOpenCodeUpdate => runHookCli(["update-check"], { environment: f.environment, cwd: f.repo, updater: { checkOpenCodeUpdate } });

  const newer = await run(async () => ({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, message: "Useful Skills 1.1.0 is available." }));
  assert.deepEqual(newer, { text: "Useful Skills 1.1.0 is available.", exitCode: 0 });

  const current = await run(async () => ({ currentVersion: "1.1.0", latestVersion: "1.1.0", updateAvailable: false, message: "Up to date." }));
  assert.deepEqual(current, { text: "", exitCode: 0 });

  const offline = await run(async () => {
    throw new Error("network down");
  });
  assert.deepEqual(offline, { text: "", exitCode: 0 });
});
