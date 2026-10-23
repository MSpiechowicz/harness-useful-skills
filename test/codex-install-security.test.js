import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findWindowsCodex, neutralCwd } from "../codex/codex-cli.js";
import { installCodex } from "../codex/install.js";
import { inspectCodexInstall } from "../codex/install-status.js";
import { uninstallCodex } from "../codex/uninstall.js";
import { createCodexSandbox, listTree, writePackage } from "./helpers/codex-install-fixture.js";

const READ_ONLY = ["--version", "plugin marketplace list", "plugin list", "mcp get"];
const changes = (calls) => calls.map((argv) => argv.join(" ")).filter((line) => !READ_ONLY.some((prefix) => line.startsWith(prefix)));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function installed(t) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  const install = (options = {}) => installCodex({ environment: box.environment, packageRoot: box.packageRoot, ...options });
  await install();
  box.clearCalls();
  const recordFile = box.at("harness-useful-skills", "install-record.json");
  return { ...box, install, recordFile, record: () => JSON.parse(readFileSync(recordFile, "utf8")) };
}

/** Codex's own files, which a crafted record must never get deleted. */
function codexOwnFiles(box) {
  const files = { "auth.json": '{"token":"secret"}\n', "sessions/s.jsonl": "{}\n" };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(box.at(rel)), { recursive: true });
    writeFileSync(box.at(rel), text);
  }
  return Object.fromEntries([...Object.entries(files), ["config.toml", readFileSync(box.at("config.toml"), "utf8")]].map(([rel, text]) => [rel, sha256(text)]));
}

test("install, uninstall and doctor refuse a crafted record and leave every file and Codex entry alone", async (t) => {
  const box = await installed(t);
  const owned = codexOwnFiles(box);
  const good = box.record();
  const other = path.join(box.root, "other-home");
  mkdirSync(other);
  const crafted = {
    "a record listing auth.json": { files: { ...good.files, "auth.json": owned["auth.json"] } },
    "a record listing config.toml": { files: { ...good.files, "config.toml": owned["config.toml"] } },
    "a record listing a session": { files: { ...good.files, "sessions/s.jsonl": owned["sessions/s.jsonl"] } },
    "another plugin": { pluginId: "someone-else@their-market" },
    "another MCP server": { mcp: { ...good.mcp, name: "their_server" } },
    "an MCP server with another command": { mcp: { ...good.mcp, command: "python", args: ["server.py"] } },
    "another marketplace": { marketplace: { ...good.marketplace, name: "their-market" } },
    "another Codex home": { codexHome: other, dataDir: path.join(other, "harness-useful-skills", "data"), mcp: null },
  };

  for (const [what, change] of Object.entries(crafted)) {
    writeFileSync(box.recordFile, JSON.stringify({ ...good, ...change }));
    const tree = listTree(box.codexHome);
    const state = box.state();
    box.clearCalls();

    await assert.rejects(box.install(), /^Error: Refusing to install; nothing was changed: The Codex install record has an unexpected format\./, what);
    assert.throws(() => uninstallCodex({ environment: box.environment }), /unexpected format\. Nothing was removed; move .*install-record\.json away/, what);
    assert.match(inspectCodexInstall({ environment: box.environment }).text, /Install record: cannot be used \(The Codex install record has an unexpected format\.\)/, what);

    assert.deepEqual(listTree(box.codexHome), tree, what);
    assert.deepEqual(box.state(), state, what);
    assert.deepEqual(changes(box.calls()), [], what);
    for (const [rel, digest] of Object.entries(owned)) assert.equal(sha256(readFileSync(box.at(rel))), digest, `${what}: ${rel}`);
  }
});

test("a foreign harness-useful-skills MCP server is not adopted through a record that names it", async (t) => {
  const box = await installed(t);
  const state = box.state();
  state.mcp["harness-useful-skills"] = { command: "python", args: ["server.py"], env: {}, enabled: true };
  box.setState(state);
  writeFileSync(box.recordFile, JSON.stringify({ ...box.record(), mcp: { name: "harness-useful-skills", command: "python", args: ["server.py"], env: {} } }));

  await assert.rejects(box.install(), /unexpected format/);
  writeFileSync(box.recordFile, JSON.stringify({ ...box.record(), mcp: null }));
  await assert.rejects(box.install(), /MCP server named harness-useful-skills \(python server\.py\) that Useful Skills did not register/);
  assert.equal(box.state().mcp["harness-useful-skills"].command, "python");
});

test("a data directory that is a symlink or a file is refused before any write", async (t) => {
  const box = await installed(t);
  const data = box.at("harness-useful-skills", "data");
  rmSync(data, { recursive: true });
  mkdirSync(path.join(box.root, "elsewhere"));
  symlinkSync(path.join(box.root, "elsewhere"), data);
  const tree = listTree(box.codexHome);

  await assert.rejects(box.install(), /^Error: Refusing to install; nothing was changed:\n {2}.*harness-useful-skills\/data is a symbolic link; the data directory must be a real directory/);
  assert.deepEqual(listTree(box.codexHome), tree);

  rmSync(data);
  writeFileSync(data, "not a directory");
  await assert.rejects(box.install(), /harness-useful-skills\/data is not a directory; the data directory must be a real directory/);
  assert.deepEqual(changes(box.calls()), []);
  assert.equal(readFileSync(data, "utf8"), "not a directory");
});

test("codex and git run from a neutral working directory, never the caller's", async (t) => {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  const cwdLog = path.join(box.root, "cwd.log");
  const environment = { ...box.environment, FAKE_CWD_LOG: cwdLog };

  await installCodex({ environment, packageRoot: box.packageRoot });
  inspectCodexInstall({ environment });
  uninstallCodex({ environment });

  const used = new Set(readFileSync(cwdLog, "utf8").trim().split("\n"));
  const allowed = new Set([realpathSync(box.codexHome), realpathSync(os.homedir()), realpathSync(os.tmpdir())]);
  assert.ok(used.size > 0);
  for (const cwd of used) assert.ok(allowed.has(cwd), cwd);
  assert.ok(used.has(realpathSync(box.codexHome)), "calls for a known Codex home run there");
  assert.equal(used.has(process.cwd()), false);

  assert.equal(neutralCwd(box.codexHome), box.codexHome);
  assert.equal(neutralCwd(path.join(box.root, "absent")), os.homedir());
  assert.equal(existsSync(path.join(box.root, "absent")), false);
});

test("Windows PATH lookup skips relative entries", () => {
  const files = new Set(["tools\\codex.exe", "C:\\npm\\codex.cmd"]);
  const found = findWindowsCodex({ PATH: "tools;.;C:\\npm" }, (file) => files.has(file));
  assert.deepEqual(found, { file: "C:\\npm\\codex.cmd", shim: true });
  assert.equal(findWindowsCodex({ PATH: "tools;." }, (file) => files.has(file)), null);
});
