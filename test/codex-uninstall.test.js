import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { installCodex } from "../codex/install.js";
import { uninstallCodex } from "../codex/uninstall.js";
import { createCodexSandbox, listTree, writePackage } from "./helpers/codex-install-fixture.js";

const READ_ONLY = ["--version", "plugin marketplace list", "plugin list", "mcp get"];
const changes = (calls) => calls.map((argv) => argv.join(" ")).filter((line) => !READ_ONLY.some((prefix) => line.startsWith(prefix)));

async function installed(t, options = {}) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  if (options.state) box.setState(options.state);
  await installCodex({ environment: box.environment, packageRoot: box.packageRoot });
  box.clearCalls();
  const uninstall = (environment = box.environment) => uninstallCodex({ environment }).message;
  return { ...box, uninstall, recordFile: box.at("harness-useful-skills", "install-record.json") };
}

test("uninstall unregisters everything it added, removes its files and record, and keeps the data directory", async (t) => {
  const box = await installed(t);
  writeFileSync(path.join(box.at("harness-useful-skills", "data"), "memory.db"), "notes");

  const message = box.uninstall();

  assert.match(message, /Uninstalled Useful Skills 0\.3\.11 from Codex .*: 18 files removed\./);
  assert.match(message, /Removed MCP server harness-useful-skills\.\nRemoved plugin harness-useful-skills@harness-useful-skills\.\nRemoved marketplace harness-useful-skills\./);
  assert.match(message, /Kept the data directory .*harness-useful-skills\/data/);
  assert.deepEqual(changes(box.calls()), ["mcp remove harness-useful-skills", "plugin remove harness-useful-skills@harness-useful-skills", "plugin marketplace remove harness-useful-skills"]);
  assert.deepEqual(listTree(box.codexHome), ["harness-useful-skills", "harness-useful-skills/data", "harness-useful-skills/data/memory.db", "harness-useful-skills/models.yml"]);
  assert.deepEqual(box.state(), { marketplaces: [], plugins: [], mcp: {} });

  assert.match(box.uninstall(), /not installed for Codex: no install record at .*Nothing was removed\./);
});

test("uninstall keeps files edited since the install and says so", async (t) => {
  const box = await installed(t);
  writeFileSync(box.at("agents", "us-planner.toml"), "mine\n");
  writeFileSync(box.at("harness-useful-skills", "runtime", "memory.js"), "// mine\n");

  const message = box.uninstall();

  assert.match(message, /16 files removed/);
  assert.match(message, /Left in place for you to review or delete:\n {2}.*agents\/us-planner\.toml \(modified since it was installed\)\n {2}.*runtime\/memory\.js \(modified since it was installed\)/);
  assert.equal(readFileSync(box.at("agents", "us-planner.toml"), "utf8"), "mine\n");
  assert.equal(existsSync(box.at("agents", "us-scout.toml")), false);
  assert.equal(existsSync(box.recordFile), false);
});

test("uninstall leaves an MCP server that no longer matches and a marketplace it did not add", async (t) => {
  const sameSource = { name: "harness-useful-skills", sourceType: "git", source: "https://github.com/MSpiechowicz/harness-useful-skills.git", ref: "v0.3.11" };
  const box = await installed(t, { state: { marketplaces: [sameSource], plugins: [], mcp: {} } });
  const state = box.state();
  state.mcp["harness-useful-skills"].args = ["/somewhere/else.js"];
  box.setState(state);

  const message = box.uninstall();

  assert.match(message, /Left MCP server harness-useful-skills alone: it is no longer what Useful Skills registered\./);
  assert.match(message, /Kept marketplace harness-useful-skills: it was added before Useful Skills was installed\./);
  assert.deepEqual(changes(box.calls()), ["plugin remove harness-useful-skills@harness-useful-skills"]);
  assert.deepEqual(box.state().marketplaces, [sameSource]);
  assert.ok(box.state().mcp["harness-useful-skills"]);
});

test("uninstall reports Codex entries that are already gone or changed source", async (t) => {
  const box = await installed(t);
  box.setState({ marketplaces: [{ name: "harness-useful-skills", sourceType: "local", source: box.root, ref: null }], plugins: [], mcp: {} });

  const message = box.uninstall();

  assert.match(message, /MCP server harness-useful-skills was already gone\./);
  assert.match(message, /Left marketplace harness-useful-skills alone: it now comes from /);
  assert.equal(box.state().marketplaces.length, 1);
});

test("a failing Codex command stops the uninstall before files are removed; running again finishes it", async (t) => {
  const box = await installed(t);
  assert.throws(() => box.uninstall({ ...box.environment, FAKE_CODEX_FAIL: "plugin remove" }), (error) => {
    assert.match(error.message, /`codex plugin remove harness-useful-skills@harness-useful-skills` failed \(exit 1\)/);
    assert.match(error.message, /stopped before removing files/);
    return true;
  });
  const record = JSON.parse(readFileSync(box.recordFile, "utf8"));
  assert.equal(record.mcp, null, "the MCP server was removed and the record says so");
  assert.equal(record.pluginId, "harness-useful-skills@harness-useful-skills");
  assert.ok(existsSync(box.at("agents", "us-planner.toml")));

  const message = box.uninstall();
  assert.match(message, /18 files removed/);
  assert.doesNotMatch(message, /MCP server/);
  assert.deepEqual(box.state().marketplaces, []);
});

test("uninstall needs the codex command and removes nothing without it", async (t) => {
  const box = await installed(t);
  const tree = listTree(box.codexHome);
  assert.throws(() => box.uninstall({ ...box.environment, PATH: box.root }), /codex command was not found on PATH; uninstalling needs it .*Nothing was removed\./);
  assert.deepEqual(listTree(box.codexHome), tree);
});

test("uninstall refuses a record behind a symlinked directory and reports a missing home", async (t) => {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  assert.match(uninstallCodex({ environment: { ...box.environment, CODEX_HOME: path.join(box.root, "absent") } }).message, /no install record/);

  mkdirSync(path.join(box.root, "elsewhere"));
  symlinkSync(path.join(box.root, "elsewhere"), box.at("harness-useful-skills"));
  assert.throws(() => uninstallCodex({ environment: box.environment }), /harness-useful-skills is a symbolic link; Useful Skills will not read an install record through it\./);
});

test("uninstall leaves a plugin alone when the install stopped before adding it", async (t) => {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  await assert.rejects(installCodex({ environment: { ...box.environment, FAKE_CODEX_FAIL: "plugin add" }, packageRoot: box.packageRoot }), /stopped while installing the plugin/);
  const state = box.state();
  state.plugins.push({ pluginId: "harness-useful-skills@harness-useful-skills", version: "0.3.11", enabled: true });
  box.setState(state);
  box.clearCalls();

  const message = uninstallCodex({ environment: box.environment }).message;

  assert.match(message, /Left plugin harness-useful-skills@harness-useful-skills alone: this install did not add it\./);
  assert.match(message, /Removed marketplace harness-useful-skills\./);
  assert.deepEqual(changes(box.calls()), ["plugin marketplace remove harness-useful-skills"]);
  assert.equal(box.state().plugins.length, 1);
});
