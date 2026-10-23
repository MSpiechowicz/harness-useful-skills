import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AGENT_MARKER, AGENT_ROLES } from "../codex/agents.js";
import { CodexMissingError, codexInvocation, findWindowsCodex } from "../codex/codex-cli.js";
import { installCodex } from "../codex/install.js";
import { codexHomeFor, readCodexRecord } from "../codex/paths.js";
import { inspectCodexInstall } from "../codex/install-status.js";
import { createCodexSandbox, listTree, writePackage } from "./helpers/codex-install-fixture.js";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "useful-skills");
const READ_ONLY = new Set(["--version", "plugin marketplace list", "plugin list", "mcp get"]);

function setup(t, packageOptions) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot, packageOptions);
  const install = (options = {}) => installCodex({ environment: box.environment, packageRoot: box.packageRoot, ...options });
  const record = () => JSON.parse(readFileSync(box.at("harness-useful-skills", "install-record.json"), "utf8"));
  return { ...box, install, record };
}

/** Calls that change Codex state, as space-joined argv. */
const changes = (calls) => calls.map((argv) => argv.join(" ")).filter((line) => ![...READ_ONLY].some((prefix) => line.startsWith(prefix)));

async function cli(args, env) {
  try {
    return { code: 0, ...(await exec(process.execPath, [LAUNCHER, ...args], { env, timeout: 30_000 })) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("a fresh install copies the runtime and agents, records them, and registers marketplace, plugin and MCP server", async (t) => {
  const box = setup(t);
  const result = await box.install();

  assert.match(result.message, /Installed Useful Skills 0\.3\.11 for Codex/);
  assert.match(result.message, /Restart Codex/);
  assert.ok(existsSync(box.at("harness-useful-skills", "runtime", "codex", "mcp-server.js")));
  assert.ok(existsSync(box.at("harness-useful-skills", "runtime", "package.json")));
  for (const role of AGENT_ROLES) {
    assert.equal(readFileSync(box.at("agents", `us-${role}.toml`), "utf8").split("\n")[0], AGENT_MARKER);
  }
  assert.equal(statSync(box.at("harness-useful-skills", "data")).mode & 0o777, 0o700);

  const server = box.at("harness-useful-skills", "runtime", "codex", "mcp-server.js");
  const dataDir = box.at("harness-useful-skills", "data");
  assert.deepEqual(changes(box.calls()), [
    "plugin marketplace add MSpiechowicz/harness-useful-skills --ref v0.3.11",
    "plugin add harness-useful-skills@harness-useful-skills --json",
    `mcp add harness-useful-skills --env USEFUL_SKILLS_DATA=${dataDir} -- node ${server}`,
  ]);
  assert.deepEqual(box.calls()[0], ["--version"]);

  const record = box.record();
  assert.equal(record.schema, 1);
  assert.equal(record.version, "0.3.11");
  assert.equal(record.codexHome, box.codexHome);
  assert.equal(record.dataDir, dataDir);
  assert.deepEqual(record.marketplace, { name: "harness-useful-skills", source: "MSpiechowicz/harness-useful-skills", ref: "v0.3.11", addedByInstaller: true });
  assert.equal(record.pluginId, "harness-useful-skills@harness-useful-skills");
  assert.equal(record.pluginVersion, "0.3.11");
  assert.deepEqual(record.mcp, { name: "harness-useful-skills", command: "node", args: [server], env: { USEFUL_SKILLS_DATA: dataDir } });
  assert.match(record.files["agents/us-planner.toml"], /^[0-9a-f]{64}$/);
  assert.match(record.files["harness-useful-skills/runtime/codex/mcp-server.js"], /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(record.files).length, 7 + 11);
});

test("--local adds the package root as the marketplace, without a ref", async (t) => {
  const box = setup(t);
  await box.install({ local: true });

  const root = realpathSync(box.packageRoot);
  assert.ok(changes(box.calls()).includes(`plugin marketplace add ${root}`));
  assert.deepEqual(box.record().marketplace, { name: "harness-useful-skills", source: root, ref: null, addedByInstaller: true });
  assert.equal(box.state().plugins[0].version, "0.3.11");
});

test("--local refuses a package root whose marketplace has another name", async (t) => {
  const box = setup(t, { marketplace: "other" });
  await assert.rejects(box.install({ local: true }), /must define the harness-useful-skills marketplace/);
  assert.deepEqual(changes(box.calls()), []);
});

test("installing again changes no file and only re-runs the idempotent plugin add", async (t) => {
  const box = setup(t);
  await box.install();
  const watched = [box.at("harness-useful-skills", "install-record.json"), box.at("agents", "us-scout.toml"), box.at("harness-useful-skills", "runtime", "memory.js")];
  const before = watched.map((file) => ({ ino: lstatSync(file).ino, mtime: lstatSync(file).mtimeMs }));
  const tree = listTree(box.codexHome);
  box.clearCalls();

  const result = await box.install();

  assert.match(result.message, /files already up to date/);
  assert.match(result.message, /MCP server harness-useful-skills is already registered/);
  assert.deepEqual(changes(box.calls()), ["plugin add harness-useful-skills@harness-useful-skills --json"]);
  assert.deepEqual(watched.map((file) => ({ ino: lstatSync(file).ino, mtime: lstatSync(file).mtimeMs })), before);
  assert.deepEqual(listTree(box.codexHome), tree);
});

test("an upgrade replaces the marketplace at the new ref and prunes owned files the bundle dropped", async (t) => {
  const box = setup(t);
  await box.install();
  writePackage(box.packageRoot, { version: "0.3.12", files: { "memory.js": null, "graph.js": "// new\n" } });
  box.clearCalls();

  const result = await box.install();

  assert.match(result.message, /Installed Useful Skills 0\.3\.12/);
  assert.match(result.message, /1 stale removed/);
  assert.deepEqual(changes(box.calls()), [
    "plugin marketplace remove harness-useful-skills",
    "plugin marketplace add MSpiechowicz/harness-useful-skills --ref v0.3.12",
    "plugin add harness-useful-skills@harness-useful-skills --json",
  ]);
  assert.equal(existsSync(box.at("harness-useful-skills", "runtime", "memory.js")), false);
  assert.ok(existsSync(box.at("harness-useful-skills", "runtime", "graph.js")));
  assert.equal(box.record().version, "0.3.12");
  assert.equal(box.record().marketplace.ref, "v0.3.12");
  assert.equal(box.record().files["harness-useful-skills/runtime/memory.js"], undefined);
  assert.equal(box.state().plugins[0].version, "0.3.12");
});

test("switching an installer-added GitHub marketplace to --local replaces it", async (t) => {
  const box = setup(t);
  await box.install();
  box.clearCalls();

  await box.install({ local: true });

  const root = realpathSync(box.packageRoot);
  assert.deepEqual(changes(box.calls()).slice(0, 2), ["plugin marketplace remove harness-useful-skills", `plugin marketplace add ${root}`]);
  assert.equal(box.record().marketplace.addedByInstaller, true);
});

test("a marketplace the user added from the same source is reused and not claimed", async (t) => {
  const box = setup(t);
  box.setState({ marketplaces: [{ name: "harness-useful-skills", sourceType: "git", source: "https://github.com/MSpiechowicz/harness-useful-skills.git", ref: null }], plugins: [], mcp: {} });
  writeFileSync(box.at("config.toml"), '[marketplaces.harness-useful-skills]\nsource = "https://github.com/MSpiechowicz/harness-useful-skills.git"\n');

  const result = await box.install();

  assert.match(result.message, /tracks its default branch, not v0\.3\.11/);
  assert.equal(changes(box.calls()).some((line) => line.startsWith("plugin marketplace")), false);
  assert.deepEqual(box.record().marketplace, { name: "harness-useful-skills", source: "MSpiechowicz/harness-useful-skills", ref: null, addedByInstaller: false });
});

/** Assert that an install was refused for `pattern` without writing a file or changing Codex. */
async function assertRefused(box, pattern) {
  const tree = listTree(box.codexHome);
  await assert.rejects(box.install(), (error) => {
    assert.match(error.message, /^Refusing to install; nothing was changed:/);
    assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(listTree(box.codexHome), tree);
  assert.deepEqual(changes(box.calls()), []);
}

test("a marketplace of the same name from another source is refused before any write", async (t) => {
  const box = setup(t);
  box.setState({ marketplaces: [{ name: "harness-useful-skills", sourceType: "git", source: "https://github.com/someone/fork.git", ref: "main" }], plugins: [], mcp: {} });
  await assertRefused(box, /marketplace named harness-useful-skills from https:\/\/github\.com\/someone\/fork\.git, which Useful Skills did not add/);
});

test("an MCP server named harness-useful-skills that Useful Skills did not register is refused before any write", async (t) => {
  const box = setup(t);
  box.setState({ marketplaces: [], plugins: [], mcp: { "harness-useful-skills": { command: "python", args: ["server.py"], env: {}, enabled: true } } });
  await assertRefused(box, /MCP server named harness-useful-skills \(python server\.py\) that Useful Skills did not register/);
});

test("an agent file the user wrote is refused before any write; one carrying the marker is replaced", async (t) => {
  const box = setup(t);
  mkdirSync(box.at("agents"));
  writeFileSync(box.at("agents", "us-planner.toml"), 'name = "us-planner"\n');
  await assertRefused(box, /us-planner\.toml: exists but Useful Skills did not install it/);

  writeFileSync(box.at("agents", "us-planner.toml"), `${AGENT_MARKER}\nname = "us-planner"\n`);
  await box.install();
  assert.ok(box.record().files["agents/us-planner.toml"]);
  assert.notEqual(readFileSync(box.at("agents", "us-planner.toml"), "utf8"), `${AGENT_MARKER}\nname = "us-planner"\n`);
});

test("a symlinked target directory or an edited installed file is refused before any write", async (t) => {
  const box = setup(t);
  mkdirSync(path.join(box.root, "elsewhere"));
  symlinkSync(path.join(box.root, "elsewhere"), box.at("agents"));
  await assertRefused(box, /agents is a symbolic link/);

  const other = setup(t);
  await other.install();
  writeFileSync(other.at("harness-useful-skills", "runtime", "memory.js"), "// mine\n");
  other.clearCalls();
  await assertRefused(other, /memory\.js: modified since it was installed/);
});

test("a failure at plugin add leaves a truthful record, and running again completes the install", async (t) => {
  const box = setup(t);
  await assert.rejects(box.install({ environment: { ...box.environment, FAKE_CODEX_FAIL: "plugin add" } }), (error) => {
    assert.match(error.message, /`codex plugin add harness-useful-skills@harness-useful-skills --json` failed \(exit 1\): Error: injected failure/);
    assert.match(error.message, /stopped while installing the plugin\. Done: 18 files in place, marketplace ready\./);
    assert.match(error.message, /\.\/useful-skills install --host codex` \(or the install script\) again/);
    return true;
  });
  const partial = box.record();
  assert.equal(partial.marketplace.addedByInstaller, true);
  assert.equal(partial.pluginId, null);
  assert.equal(partial.pluginVersion, null);
  assert.equal(partial.mcp, null);
  assert.equal(Object.keys(partial.files).length, 18);
  box.clearCalls();

  await box.install();

  assert.deepEqual(changes(box.calls()).map((line) => line.split(" --env")[0]), ["plugin add harness-useful-skills@harness-useful-skills --json", "mcp add harness-useful-skills"]);
  assert.equal(box.record().pluginId, "harness-useful-skills@harness-useful-skills");
  assert.equal(box.record().marketplace.addedByInstaller, true);
  assert.ok(box.record().mcp);
});

test("a release source that provides another marketplace is removed again and reported", async (t) => {
  const box = setup(t);
  await assert.rejects(box.install({ environment: { ...box.environment, FAKE_CODEX_GIT_NAME: "another-marketplace" } }), /MSpiechowicz\/harness-useful-skills at v0\.3\.11 does not provide the harness-useful-skills marketplace \(it provides another-marketplace, which was removed again\)/);
  assert.deepEqual(box.state().marketplaces, []);
  assert.equal(box.record().marketplace, null);
});

test("a missing codex command is reported before anything is created", async (t) => {
  const box = setup(t);
  const environment = { ...box.environment, PATH: path.join(box.root, "home"), CODEX_HOME: path.join(box.root, "absent") };
  await assert.rejects(box.install({ environment }), /The codex command was not found on PATH/);
  assert.equal(existsSync(path.join(box.root, "absent")), false);
});

test("CODEX_HOME must be absolute and printable; a missing one is created", async (t) => {
  const box = setup(t);
  await assert.rejects(box.install({ environment: { ...box.environment, CODEX_HOME: "relative/home" } }), /CODEX_HOME must be an absolute path/);
  await assert.rejects(box.install({ environment: { ...box.environment, CODEX_HOME: path.join(box.root, "bad\u001b[2J") } }), /control characters/);

  const fresh = path.join(box.root, "new-home");
  await box.install({ environment: { ...box.environment, CODEX_HOME: fresh } });
  assert.ok(existsSync(path.join(fresh, "harness-useful-skills", "install-record.json")));
  assert.ok(existsSync(path.join(box.root, "home")) && !existsSync(path.join(box.root, "home", ".codex")));
});

test("doctor reports a missing codex, an empty home, a full install, a marketplace-only plugin and a damaged record", async (t) => {
  const box = setup(t);
  const doctor = (environment = box.environment) => inspectCodexInstall({ environment }).text;

  const missing = doctor({ ...box.environment, PATH: box.root });
  assert.match(missing, /Codex CLI: not found on PATH/);
  assert.match(missing, /not checked without the codex command/);

  const empty = doctor();
  assert.match(empty, /Codex CLI: codex-cli 0\.154\.0/);
  assert.match(empty, /Install record: none at /);
  assert.match(empty, /Agents: none of the 7/);
  assert.match(empty, /Plugin harness-useful-skills@harness-useful-skills: not installed\./);
  assert.match(empty, /MCP server harness-useful-skills: not registered\./);
  assert.match(empty, /tool_timeout_sec under \[mcp_servers\.harness-useful-skills\]/);
  assert.match(doctor({ ...box.environment, CODEX_HOME: path.join(box.root, "absent") }), /\(missing\); Useful Skills is not installed\./);

  box.setState({ marketplaces: [{ name: "harness-useful-skills", sourceType: "git", source: "https://github.com/MSpiechowicz/harness-useful-skills.git", ref: null }], plugins: [{ pluginId: "harness-useful-skills@harness-useful-skills", version: "0.3.11", enabled: true }], mcp: {} });
  assert.match(doctor(), /skills only; memory tools and agents unavailable; run `\.\/useful-skills install --host codex`/);

  box.setState({ marketplaces: [], plugins: [], mcp: {} });
  await box.install();
  writeFileSync(box.at("agents", "us-scout.toml"), "edited\n");
  const full = doctor();
  assert.match(full, /Install record: Useful Skills 0\.3\.11\./);
  assert.match(full, /Files: 17 ok, 1 modified, 0 missing\./);
  assert.match(full, /Agents: 6 of 7 ok .*\n {2}us-scout\.toml: modified/);
  assert.match(full, /installed, enabled, version 0\.3\.11 \(matches the install record\)/);
  assert.match(full, /Marketplace harness-useful-skills: added from https:\/\/github\.com\/MSpiechowicz\/harness-useful-skills\.git at v0\.3\.11\./);
  assert.match(full, /MCP server harness-useful-skills: registered as installed\./);
  assert.match(full, /Data directory: .* \(present, mode 700\)\./);
  assert.doesNotMatch(full, /skills only/);

  writeFileSync(box.at("harness-useful-skills", "install-record.json"), "{");
  assert.match(doctor(), /Install record: cannot be used \(The Codex install record is not valid JSON\.\)/);
  await assert.rejects(box.install(), /not valid JSON/);
});

test("the CLI validates Codex arguments before running anything", async (t) => {
  const box = setup(t);
  const env = box.environment;
  const cases = {
    "install --host codex --scope user": /^useful-skills: --scope is not valid with --host codex; Codex installs into CODEX_HOME\.\nUsage:/,
    "install --host codex --profile work": /^useful-skills: --profile is not valid with --host codex/,
    "doctor --host codex --local": /^useful-skills: --local is valid only with install --host codex\.\n/,
    "install --host codex --bogus": /^useful-skills: Unknown argument: --bogus\n/,
    "install --host codex --local --local": /^useful-skills: --local may be given only once\.\n/,
    "update status --host codex": /^useful-skills: Expected update --host codex\.\n/,
  };
  for (const [args, expected] of Object.entries(cases)) {
    const result = await cli(args.split(" "), env);
    assert.equal(result.code, 2, args);
    assert.match(result.stderr, expected, args);
  }
  assert.deepEqual(box.calls(), []);

  const update = await cli(["update", "--host", "codex"], env);
  assert.equal(update.code, 0);
  assert.match(update.stdout, /HARNESS_SKILLS_HOST=codex/);
  assert.match((await cli(["uninstall", "--host", "codex"], { ...env, PATH: box.root })).stdout, /not installed for Codex/);
  const missing = await cli(["install", "--host", "codex"], { ...env, PATH: box.root });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^useful-skills: The codex command was not found on PATH/);
});

test("the CLI installs the repository's own bundle with --local, and doctor reads it back", async (t) => {
  const box = setup(t);
  const install = await cli(["install", "--host", "codex", "--local"], box.environment);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /Installed Useful Skills \d+\.\d+\.\d+ for Codex/);
  assert.equal(box.record().marketplace.source, realpathSync(ROOT));

  const doctor = await cli(["doctor", "--host", "codex"], box.environment);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /Agents: 7 of 7 ok/);
  assert.match(doctor.stdout, /MCP server harness-useful-skills: registered as installed\./);
});

test("a default install checks the release tag with git first and refuses a missing tag before any write", async (t) => {
  const box = setup(t);
  const fresh = path.join(box.root, "fresh-home");
  await assert.rejects(box.install({ environment: { ...box.environment, CODEX_HOME: fresh, FAKE_GIT_TAGS: "v0.3.10" } }), (error) => {
    assert.match(error.message, /^Refusing to install; nothing was changed: release tag v0\.3\.11 does not exist on github\.com\/MSpiechowicz\/harness-useful-skills/);
    assert.match(error.message, /install with `\.\/useful-skills install --host codex --local` instead\./);
    return true;
  });
  assert.equal(existsSync(fresh), false);
  assert.deepEqual(changes(box.calls()), []);
  assert.deepEqual(box.gitCalls(), [{ args: ["ls-remote", "--tags", "https://github.com/MSpiechowicz/harness-useful-skills", "refs/tags/v0.3.11"], prompt: "0" }]);

  const present = await box.install();
  assert.doesNotMatch(present.message, /could not check/);
});

test("an offline or missing git only adds a note, and --local skips the tag check", async (t) => {
  const box = setup(t);
  const offline = await box.install({ environment: { ...box.environment, FAKE_GIT_FAIL: "1" } });
  assert.match(offline.message, /Note: could not check that release tag v0\.3\.11 exists \(git ls-remote failed: fatal: unable to access/);

  rmSync(path.join(box.bin, "git"));
  assert.match((await box.install()).message, /Note: could not check that release tag v0\.3\.11 exists \(git is not on PATH\); continuing\./);

  const local = setup(t);
  await local.install({ local: true });
  assert.deepEqual(local.gitCalls(), []);
});

test("with the record lost, identical files are adopted, and differing runtime files name the directory to move away", async (t) => {
  const box = setup(t);
  await box.install();
  rmSync(box.at("harness-useful-skills", "install-record.json"));

  await box.install();
  assert.equal(Object.keys(box.record().files).length, 18);

  rmSync(box.at("harness-useful-skills", "install-record.json"));
  writePackage(box.packageRoot, { version: "0.3.12" });
  box.clearCalls();
  await assertRefused(box, new RegExp(`${box.at("harness-useful-skills", "runtime").replaceAll("/", "\\/")} holds runtime files the install record does not list .* move that directory away`));
});

test("after a partial upgrade the record keeps the old plugin version and doctor reports the plugin as stale", async (t) => {
  const box = setup(t);
  await box.install();
  writePackage(box.packageRoot, { version: "0.3.12" });
  await assert.rejects(box.install({ environment: { ...box.environment, FAKE_CODEX_FAIL: "plugin add" } }), /stopped while installing the plugin/);

  assert.equal(box.record().version, "0.3.12");
  assert.equal(box.record().pluginVersion, "0.3.11");
  const doctor = inspectCodexInstall({ environment: box.environment }).text;
  assert.match(doctor, /Install record: Useful Skills 0\.3\.12 files, but the plugin is recorded at 0\.3\.11: the install did not finish/);
  assert.match(doctor, /installed, enabled, version 0\.3\.11 \(stale: the installed files are 0\.3\.12; run `\.\/useful-skills install --host codex`\)/);

  await box.install();
  assert.equal(box.record().pluginVersion, "0.3.12");
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /Install record: Useful Skills 0\.3\.12\.\n/);

  // A record from before pluginVersion existed: the plugin version is unknown, and the live plugin is compared with record.version.
  const { pluginVersion: _unused, ...older } = box.record();
  writeFileSync(box.at("harness-useful-skills", "install-record.json"), JSON.stringify(older));
  const olderDoctor = inspectCodexInstall({ environment: box.environment }).text;
  assert.match(olderDoctor, /Install record: Useful Skills 0\.3\.12\.\n/);
  assert.doesNotMatch(olderDoctor, /did not finish/);
  assert.match(olderDoctor, /version 0\.3\.12 \(matches the install record\)/);
  const state = box.state();
  state.plugins[0].version = "0.3.11";
  box.setState(state);
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /version 0\.3\.11 \(stale: the installed files are 0\.3\.12/);
});

test("Windows: codex.exe anywhere on PATH wins and runs directly; POSIX always runs codex", () => {
  const files = new Set(["C:\\npm\\codex.cmd", "D:\\tools\\codex.exe"]);
  const exists = (file) => files.has(file);
  const environment = { Path: "C:\\npm;\"D:\\tools\"", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  assert.deepEqual(findWindowsCodex(environment, exists), { file: "D:\\tools\\codex.exe", shim: false });
  assert.deepEqual(codexInvocation(["--version"], { platform: "win32", environment, exists }), { command: "D:\\tools\\codex.exe", args: ["--version"], verbatim: false });
  assert.deepEqual(codexInvocation(["--version"], { platform: "linux", environment, exists }), { command: "codex", args: ["--version"], verbatim: false });

  files.delete("D:\\tools\\codex.exe");
  assert.deepEqual(findWindowsCodex(environment, exists), { file: "C:\\npm\\codex.cmd", shim: true });
  assert.equal(findWindowsCodex({ ...environment, PATHEXT: ".EXE" }, exists), null);
  assert.throws(() => codexInvocation(["--version"], { platform: "win32", environment: { ...environment, PATHEXT: ".EXE" }, exists }), CodexMissingError);
});

test("Windows: a codex.cmd shim runs through cmd.exe with quoted arguments, or is refused for cmd metacharacters", () => {
  const exists = (file) => file === "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
  const environment = { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const invocation = codexInvocation(["mcp", "add", "harness-useful-skills", "--env", "USEFUL_SKILLS_DATA=C:\\Users\\me\\.codex (x)\\data", "--", "node", "C:\\dir\\", ""], { platform: "win32", environment, exists });

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.verbatim, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], '""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" "mcp" "add" "harness-useful-skills" "--env" "USEFUL_SKILLS_DATA=C:\\Users\\me\\.codex (x)\\data" "--" "node" "C:\\dir\\\\" """');
  const shellFor = (variables) => codexInvocation(["--version"], { platform: "win32", environment: { PATH: environment.PATH, ...variables }, exists }).command;
  assert.equal(shellFor({ COMSPEC: "relative.exe", systemroot: "C:\\Windows" }), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(shellFor({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\cmd.exe");
  for (const variables of [{}, { COMSPEC: "cmd.exe", SystemRoot: "Windows" }]) {
    assert.throws(() => shellFor(variables), /neither COMSPEC nor SystemRoot is an absolute path, so cmd\.exe cannot be located safely/, JSON.stringify(variables));
  }

  for (const unsafe of ['a"b', "50%", "wow!", "a^b", "a&b", "a|b", "a<b", "a>b", "a\nb"]) {
    assert.throws(() => codexInvocation(["plugin", "marketplace", "add", unsafe], { platform: "win32", environment, exists }), /has to run through cmd\.exe, .* install the codex\.exe build/, unsafe);
  }
});

test("CODEX_HOME defaults to the home directory, and the install record is read strictly", async (t) => {
  assert.equal(codexHomeFor({ HOME: "/users/me", CODEX_HOME: "" }), path.join("/users/me", ".codex"));
  assert.equal(codexHomeFor({ HOME: "relative" }), path.join(os.homedir(), ".codex"));

  const box = setup(t);
  await box.install();
  const file = box.at("harness-useful-skills", "install-record.json");
  const good = box.record();
  const variants = [
    { schema: 2 },
    { version: "1.0" },
    { codexHome: "relative" },
    { dataDir: null },
    { marketplace: { name: "m", source: "s", ref: 1, addedByInstaller: true } },
    { mcp: { name: "harness-useful-skills", command: "node", args: [1], env: {} } },
    { pluginId: 7 },
    { pluginVersion: 7 },
    { files: [] },
    { files: { "../escape": "0".repeat(64) } },
    { files: { "a/b": "not-a-sha" } },
    { dataDir: "/tmp/evil\u001b[2J" },
  ];
  for (const change of variants) {
    writeFileSync(file, JSON.stringify({ ...good, ...change }));
    assert.throws(() => readCodexRecord(file, box.codexHome), /unexpected format/, JSON.stringify(change));
  }

  writeFileSync(file, JSON.stringify(good));
  assert.deepEqual(readCodexRecord(file, box.codexHome), good);
  writeFileSync(file, " ".repeat(1024 * 1024 + 1));
  assert.throws(() => readCodexRecord(file, box.codexHome), /too large/);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => readCodexRecord(file, box.codexHome), /must be a regular file/);
  rmSync(file, { recursive: true });
  symlinkSync(path.join(box.root, "elsewhere.json"), file);
  assert.throws(() => readCodexRecord(file, box.codexHome), /must not be a symbolic link/);
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /Install record: cannot be used \(The Codex install record must not be a symbolic link\.\)/);
});
