import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createCommandRunner } from "../command-core.js";
import { workspaceMemoryPaths } from "../memory-paths.js";
import { runCommand } from "../opencode/command.js";
import { installRecordPath } from "../opencode/paths.js";

const execute = promisify(execFile);
const COMMAND = fileURLToPath(new URL("../opencode/command.js", import.meta.url));

/** Temp HOME/XDG dirs, a Git repository, and a private data dir; never the real user dirs. */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-command-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const base = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "share"),
  };
  const configDir = path.join(base.XDG_CONFIG_HOME, "opencode");
  const dataDir = path.join(root, "data");
  const repo = path.join(root, "repo");
  for (const directory of [base.HOME, configDir, dataDir, path.join(repo, ".git")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await writeFile(path.join(repo, "main.py"), "def main(): pass\n");

  const environment = { ...base, USEFUL_SKILLS_DATA: dataDir };
  const run = (argv, options = {}) => runCommand(argv, { environment, cwd: repo, ...options });
  return { root, base, environment, configDir, dataDir, repo, run };
}

async function direct(f, args) {
  return execute(process.execPath, [COMMAND, ...args], { cwd: f.repo, env: f.environment })
    .then(({ stdout }) => ({ exitCode: 0, text: stdout }), error => ({ exitCode: error.code, text: error.stderr }));
}

test("bare /useful-skills prints help with chat and terminal commands", async t => {
  const f = await fixture(t);
  const { text, exitCode } = await f.run([]);
  assert.equal(exitCode, 0);
  for (const command of ["/useful-skills update install", "/useful-skills doctor --check", "./useful-skills install --host opencode", "./useful-skills uninstall --host opencode", "./useful-skills list"]) {
    assert.ok(text.includes(command), command);
  }
  assert.deepEqual(await f.run(["help"]), { text, exitCode: 0 });
});

test("direct runs accept the plugin's single argument string like split arguments", async t => {
  const f = await fixture(t);
  const joined = await direct(f, ["stage plan disabled"]);
  assert.deepEqual(joined, { exitCode: 0, text: "Useful Skills plan disabled for this OpenCode profile.\n" });
  assert.deepEqual(await direct(f, ["stage", "plan", "disabled"]), joined);

  const status = JSON.parse((await direct(f, ["status --json"])).text);
  assert.equal(status.directory, path.join(f.configDir, "harness-useful-skills", "workflow-settings"));
  assert.deepEqual(status.stages.plan, { saved: "disabled", effective: "disabled", source: "file" });
  assert.deepEqual(status.workflow, { saved: "enabled", effective: "enabled", source: "default" });

  const unknown = await direct(f, ["bogus"]);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.text, /^Unknown \/useful-skills command\./);
});

test("a missing OpenCode config dir reads as default settings and is created on the first write", async t => {
  const f = await fixture(t);
  await rm(f.base.XDG_CONFIG_HOME, { recursive: true, force: true });

  const before = JSON.parse((await f.run(["status --json"])).text);
  assert.equal(before.directory, path.join(f.configDir, "harness-useful-skills", "workflow-settings"));
  assert.equal(before.scopeRoot, f.repo);
  assert.deepEqual(before.workflow, { saved: "enabled", effective: "enabled", source: "default" });
  assert.deepEqual(before.stages.review, { saved: "enabled", effective: "enabled", source: "default" });
  await assert.rejects(stat(f.base.XDG_CONFIG_HOME), { code: "ENOENT" }, "reading creates nothing");

  assert.deepEqual(await f.run(["workflow disabled"]), { text: `Useful Skills workflow disabled for this repository/workspace (${f.repo}).`, exitCode: 0 });
  assert.equal((await stat(path.join(f.configDir, "harness-useful-skills"))).mode & 0o777, 0o700);
  assert.deepEqual(await f.run(["stage", "plan", "disabled"]), { text: "Useful Skills plan disabled for this OpenCode profile.", exitCode: 0 });

  const after = JSON.parse((await f.run(["status --json"])).text);
  assert.deepEqual(after.workflow, { saved: "disabled", effective: "disabled", source: "file" });
  assert.deepEqual(after.stages.plan, { saved: "disabled", effective: "disabled", source: "file" });
});

test("list shows the OpenCode skills with their skill tool names", async t => {
  const f = await fixture(t);
  const { text, exitCode } = await f.run(["list", "ignore"]);
  assert.equal(exitCode, 0);
  assert.match(text, /\n {2}us-ignore-workflow — /);
  assert.match(text, /\n {4}skill tool: us-ignore-workflow(\n|$)/);
});

test("update check and install run the OpenCode updater and report failures", async t => {
  const f = await fixture(t);
  const calls = [];
  const updater = {
    checkOpenCodeUpdate: async options => {
      calls.push(["check", options]);
      return { currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, message: "Useful Skills 1.1.0 is available." };
    },
    installOpenCodeUpdate: async () => {
      throw new Error("Download failed.");
    },
  };

  assert.deepEqual(await f.run(["update check"], { updater }), { text: "Useful Skills 1.1.0 is available.", exitCode: 0 });
  assert.equal(calls[0][1].environment, f.environment);

  const failed = await f.run(["update", "install"], { updater });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.text, /^Useful Skills update install failed: Download failed\./);

  const usage = await f.run(["update now"], { updater });
  assert.equal(usage.exitCode, 2);
  assert.match(usage.text, /^Expected \/useful-skills update check\|install\./);
});

test("the retired graph test command is unknown and help no longer lists it", async t => {
  const f = await fixture(t);
  const { text } = await f.run([]);
  assert.doesNotMatch(text, /graph test|Graphify|graph_build|graph_query/);
  for (const argv of [["graph test"], ["graph", "test"]]) {
    const result = await f.run(argv);
    assert.equal(result.exitCode, 2);
    assert.match(result.text, /^Unknown \/useful-skills command\./);
  }
});

test("doctor explains a missing install instead of guessing a data dir", async t => {
  const f = await fixture(t);
  const environment = f.base;

  const doctor = await f.run(["doctor", "--check"], { environment, inspectInstall: ({ scope }) => ({ text: `OpenCode install (${scope} scope): not installed.` }) });
  assert.equal(doctor.exitCode, 1);
  assert.match(doctor.text, /install --host opencode/);
  assert.match(doctor.text, /\n\nOpenCode install \(user scope\): not installed\.$/);
  assert.equal(doctor.text.split("OpenCode install (").length, 2, "the install header appears once");
});

test("doctor sets up OpenCode memory in the recorded data dir and appends install status", async t => {
  const f = await fixture(t);
  const scopeRoot = f.configDir;
  const runtimeRoot = path.join(scopeRoot, "plugins", "harness-useful-skills");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(installRecordPath(scopeRoot), JSON.stringify({
    schema: 1, version: "1.0.0", scope: "user", scopeRoot, dataDir: f.dataDir, configFile: null, mcpEntry: null, files: {},
  }));

  const doctorServices = { probeCodeGraph: async () => ({ outcome: "available", state: "ok" }) };
  const inspections = [];
  const inspectInstall = options => {
    inspections.push(options);
    return { text: `OpenCode install (${options.scope} scope): Useful Skills 1.0.0 in ${scopeRoot}` };
  };

  const report = await f.run(["doctor"], { environment: f.base, packageRoot: runtimeRoot, doctorServices, inspectInstall });
  assert.equal(report.exitCode, 0, report.text);
  assert.match(report.text, /\nSetup\n {2}Facts: created\n {2}Code graph: available\n/);
  assert.ok(report.text.endsWith(`\n\nOpenCode install (user scope): Useful Skills 1.0.0 in ${scopeRoot}`), report.text);
  assert.equal(report.text.split("OpenCode install (").length, 2, "the install header appears once");
  assert.equal(report.text.includes(f.dataDir), false, "the data dir path is masked");
  assert.deepEqual(inspections, [{ scope: "user", cwd: f.repo, environment: f.base }]);

  const paths = await workspaceMemoryPaths({ cwd: f.repo, agentDir: f.dataDir });
  assert.deepEqual(await readdir(paths.directory).then(entries => entries.filter(entry => entry.endsWith("-facts"))), ["opencode-facts"]);

  const usage = await f.run(["doctor", "--fix"], { inspectInstall });
  assert.equal(usage.exitCode, 2);
  assert.equal(inspections.length, 1, "a usage error gets no install status");
});

test("a command host profile must choose guidance text or a handler for update, not both or neither", () => {
  const profile = { updateGuidance: "Update elsewhere." };
  assert.equal(typeof createCommandRunner(profile), "function");
  assert.equal(typeof createCommandRunner({ update: async () => {} }), "function");

  const handler = async () => {};
  for (const misconfigured of [
    { ...profile, update: handler },
    {},
    { update: "not a function" },
  ]) {
    assert.throws(() => createCommandRunner(misconfigured), /exactly one of/);
  }
});
