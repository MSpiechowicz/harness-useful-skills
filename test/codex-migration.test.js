import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { AGENT_ROLES } from "../codex/agents.js";
import { installCodex } from "../codex/install.js";
import { inspectCodexInstall } from "../codex/install-status.js";
import { uninstallCodex } from "../codex/uninstall.js";
import { LEGACY_CODEX_PLUGIN_ID, LEGACY_DATA_DIRECTORY, LEGACY_MCP_SERVER_NAME } from "../legacy-names.js";
import { sha256 } from "../opencode/install-files.js";
import { createCodexSandbox, listTree, writePackage } from "./helpers/codex-install-fixture.js";

const GITHUB = "https://github.com/MSpiechowicz/harness-useful-skills.git";
const READ_ONLY = ["--version", "plugin marketplace list", "plugin list", "mcp get"];
const changes = calls => calls.map(argv => argv.join(" ")).filter(line => !READ_ONLY.some(prefix => line.startsWith(prefix)));

function setup(t, { version = "0.3.12" } = {}) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot, { version });
  const legacy = box.at(LEGACY_DATA_DIRECTORY);
  return {
    ...box,
    legacy,
    install: (options = {}) => installCodex({ environment: box.environment, packageRoot: box.packageRoot, ...options }),
    uninstall: () => uninstallCodex({ environment: box.environment }).message,
    doctor: () => inspectCodexInstall({ environment: box.environment }).text,
    legacyRecord: () => JSON.parse(readFileSync(path.join(legacy, "install-record.json"), "utf8")),
  };
}

function put(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode) chmodSync(file, mode);
}

/** A Codex install as 0.3.x wrote it: runtime, agents, data, record, plugin, MCP server and marketplace. */
function writeEarlierInstall(box) {
  const runtime = {
    "package.json": "{\"name\":\"useful-skills-codex-runtime\"}\n",
    "codex/mcp-server.js": "// earlier mcp\n",
    "memory.js": "// earlier memory\n",
  };
  const files = {};
  for (const [rel, text] of Object.entries(runtime)) {
    put(path.join(box.legacy, "runtime", ...rel.split("/")), text);
    files[`${LEGACY_DATA_DIRECTORY}/runtime/${rel}`] = sha256(text);
  }

  for (const role of AGENT_ROLES) {
    const text = readFileSync(new URL(`../codex/agents/${role}.toml`, import.meta.url), "utf8");
    put(box.at("agents", `us-${role}.toml`), text);
    files[`agents/us-${role}.toml`] = sha256(text);
  }

  const dataDir = path.join(box.legacy, "data");
  const server = path.join(box.legacy, "runtime", "codex", "mcp-server.js");
  put(path.join(dataDir, LEGACY_DATA_DIRECTORY, "memory", "abc", "notes.md"), "remembered\n", 0o600);
  put(path.join(dataDir, LEGACY_DATA_DIRECTORY, "dependencies", "lock", "python"), "#!/old\n");
  for (const directory of [dataDir, path.join(dataDir, LEGACY_DATA_DIRECTORY), path.join(dataDir, LEGACY_DATA_DIRECTORY, "memory"), path.join(dataDir, LEGACY_DATA_DIRECTORY, "memory", "abc")]) chmodSync(directory, 0o700);

  const mcp = { name: LEGACY_MCP_SERVER_NAME, command: "node", args: [server], env: { USEFUL_SKILLS_DATA: dataDir } };
  put(path.join(box.legacy, "install-record.json"), `${JSON.stringify({
    schema: 1,
    version: "0.3.11",
    codexHome: box.codexHome,
    dataDir,
    files,
    marketplace: { name: "harness-useful-skills", source: "MSpiechowicz/harness-useful-skills", ref: "v0.3.11", addedByInstaller: true },
    pluginId: LEGACY_CODEX_PLUGIN_ID,
    pluginVersion: "0.3.11",
    mcp,
  }, null, 2)}\n`);

  box.setState({
    marketplaces: [{ name: "harness-useful-skills", sourceType: "git", source: GITHUB, ref: "v0.3.11" }],
    plugins: [{ pluginId: LEGACY_CODEX_PLUGIN_ID, version: "0.3.11", enabled: true }],
    mcp: { [LEGACY_MCP_SERVER_NAME]: { command: "node", args: [server], env: { USEFUL_SKILLS_DATA: dataDir }, enabled: true } },
  });
  writeFileSync(box.at("config.toml"), `[marketplaces.harness-useful-skills]\nsource = "${GITHUB}"\nref = "v0.3.11"\n`);
  return { dataDir, server };
}

test("installing over a 0.3.x install replaces its plugin, MCP server, runtime and record", async t => {
  const box = setup(t);
  writeEarlierInstall(box);
  box.clearCalls();

  const result = await box.install();

  assert.deepEqual(changes(box.calls()).filter(line => /remove|add/.test(line)), [
    "plugin marketplace remove harness-useful-skills",
    "plugin marketplace add MSpiechowicz/harness-useful-skills --ref v0.3.12",
    "plugin add harness-useful-skills@harness-useful-skills --json",
    `mcp add harness-useful-skills --env USEFUL_SKILLS_DATA=${box.at("harness-useful-skills", "data")} -- node ${box.at("harness-useful-skills", "runtime", "codex", "mcp-server.js")}`,
    `mcp remove ${LEGACY_MCP_SERVER_NAME}`,
    `plugin remove ${LEGACY_CODEX_PLUGIN_ID}`,
  ]);
  assert.deepEqual(box.state().plugins.map(plugin => plugin.pluginId), ["harness-useful-skills@harness-useful-skills"]);
  assert.deepEqual(Object.keys(box.state().mcp), ["harness-useful-skills"]);

  assert.equal(existsSync(box.legacy), false, "the earlier folder is gone");
  assert.ok(existsSync(box.at("harness-useful-skills", "runtime", "codex", "mcp-server.js")));
  assert.match(result.message, /Removed the earlier MCP server useful_skills\./);
  assert.match(result.message, /Removed the earlier plugin useful-skills@harness-useful-skills\./);
});

test("the earlier data directory moves with its memory and without the environment cache", async t => {
  const box = setup(t);
  writeEarlierInstall(box);

  await box.install();

  const moved = box.at("harness-useful-skills", "data");
  assert.equal(readFileSync(path.join(moved, "harness-useful-skills", "memory", "abc", "notes.md"), "utf8"), "remembered\n");
  assert.equal(existsSync(path.join(moved, "harness-useful-skills", "dependencies")), false);
  assert.equal(existsSync(path.join(moved, LEGACY_DATA_DIRECTORY)), false);
});

test("the marketplace the earlier install added is still the installer's to remove", async t => {
  const box = setup(t);
  writeEarlierInstall(box);

  await box.install();
  const record = JSON.parse(readFileSync(box.at("harness-useful-skills", "install-record.json"), "utf8"));
  assert.equal(record.marketplace.addedByInstaller, true);
  assert.equal(record.pluginId, "harness-useful-skills@harness-useful-skills");

  box.clearCalls();
  const message = box.uninstall();
  assert.match(message, /Removed marketplace harness-useful-skills\./);
});

test("an earlier runtime file the user edited is kept and reported", async t => {
  const box = setup(t);
  writeEarlierInstall(box);
  writeFileSync(path.join(box.legacy, "runtime", "memory.js"), "// my change\n");

  const result = await box.install();

  assert.equal(readFileSync(path.join(box.legacy, "runtime", "memory.js"), "utf8"), "// my change\n");
  assert.equal(existsSync(path.join(box.legacy, "runtime", "codex", "mcp-server.js")), false, "unchanged earlier files are removed");
  assert.match(result.message, /Left a stale file from an earlier install in place: .*memory\.js \(modified since it was installed\)/);
  assert.match(box.doctor(), /Earlier install: .*useful-skills still exists/);
});

test("an earlier MCP server the user changed is left registered", async t => {
  const box = setup(t);
  writeEarlierInstall(box);
  const state = box.state();
  state.mcp[LEGACY_MCP_SERVER_NAME].args = ["/my/server.js"];
  box.setState(state);
  box.clearCalls();

  const result = await box.install();

  assert.match(result.message, /Left MCP server useful_skills alone: it is no longer what the earlier install registered\./);
  assert.ok(box.state().mcp[LEGACY_MCP_SERVER_NAME]);
  assert.equal(changes(box.calls()).some(line => line.startsWith(`mcp remove`)), false);
  assert.match(box.doctor(), /Earlier install: MCP server useful_skills is still registered/);
});

test("a failed removal of the earlier plugin is reported and keeps its record for the next run", async t => {
  const box = setup(t);
  writeEarlierInstall(box);

  const result = await box.install({ environment: { ...box.environment, FAKE_CODEX_FAIL: `plugin remove ${LEGACY_CODEX_PLUGIN_ID}` } });

  assert.match(result.message, /Could not remove plugin useful-skills@harness-useful-skills/);
  const record = box.legacyRecord();
  assert.equal(record.pluginId, LEGACY_CODEX_PLUGIN_ID);
  assert.equal(record.mcp, null);
  assert.deepEqual(record.files, {});

  const again = await box.install();
  assert.match(again.message, /Removed the earlier plugin/);
  assert.equal(existsSync(box.legacy), false);
});

test("a data file that differs in both places stays in the old folder and is reported", async t => {
  const box = setup(t);
  const { dataDir } = writeEarlierInstall(box);
  put(path.join(dataDir, "shared.txt"), "old\n");
  put(box.at("harness-useful-skills", "data", "shared.txt"), "new\n");

  const result = await box.install();

  assert.equal(readFileSync(path.join(box.legacy, "data", "shared.txt"), "utf8"), "old\n");
  assert.equal(readFileSync(box.at("harness-useful-skills", "data", "shared.txt"), "utf8"), "new\n");
  assert.match(result.message, /Left .*shared\.txt in place: it differs from the file at the new location/);
});

test("doctor reports an earlier install before it is replaced and nothing after", async t => {
  const box = setup(t);
  writeEarlierInstall(box);

  const before = box.doctor();
  assert.match(before, new RegExp(`Earlier install: Useful Skills 0\\.3\\.11 is still recorded at .*${LEGACY_DATA_DIRECTORY}/install-record\\.json`));
  assert.match(before, /Earlier install: plugin useful-skills@harness-useful-skills is still installed/);
  assert.match(before, /Earlier install: MCP server useful_skills is still registered/);

  await box.install();
  assert.doesNotMatch(box.doctor(), /Earlier install/);
});

test("installing again after the migration changes nothing", async t => {
  const box = setup(t);
  writeEarlierInstall(box);
  await box.install();
  box.clearCalls();
  const tree = listTree(box.codexHome);

  const again = await box.install();

  assert.match(again.message, /files already up to date/);
  assert.doesNotMatch(again.message, /earlier/i);
  assert.deepEqual(listTree(box.codexHome), tree);
});

test("uninstall removes an earlier install by its own record, and both when both are recorded", async t => {
  const box = setup(t);
  writeEarlierInstall(box);

  const message = box.uninstall();

  assert.match(message, /Uninstalled Useful Skills 0\.3\.11 from Codex/);
  assert.deepEqual(box.state(), { marketplaces: [], plugins: [], mcp: {} });
  assert.equal(existsSync(path.join(box.legacy, "install-record.json")), false);
  assert.ok(existsSync(path.join(box.legacy, "data")), "the data directory is kept");
  assert.match(message, /Kept the data directory .*useful-skills\/data/);
});

test("uninstall with a new install and an unfinished earlier one removes both", async t => {
  const box = setup(t);
  writeEarlierInstall(box);
  await box.install();
  writeEarlierInstall(box);
  box.setState({ ...box.state(), mcp: { ...box.state().mcp } });

  const message = box.uninstall();

  assert.match(message, /Uninstalled Useful Skills 0\.3\.12 and 0\.3\.11 from Codex/);
  assert.equal(existsSync(box.at("harness-useful-skills", "install-record.json")), false);
  assert.equal(existsSync(path.join(box.legacy, "install-record.json")), false);
  assert.deepEqual(Object.keys(box.state().mcp), []);
});
