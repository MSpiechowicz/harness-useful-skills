import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bundleVersion, defaultDataDir, installRecordPath, opencodeConfigDir, readInstallRecord,
  printableText, resolveDataDir, RUNTIME_ROOT, runtimeInstall, scopeRootFor,
} from "../opencode/paths.js";

async function temporaryRoot(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-opencode-paths-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function record(scopeRoot, overrides = {}) {
  return {
    schema: 1,
    version: "1.2.3",
    scope: "user",
    scopeRoot,
    dataDir: path.join(scopeRoot, "data"),
    configFile: path.join(scopeRoot, "opencode.json"),
    mcpEntry: { type: "local", command: ["node", "/x/mcp-server.js"], enabled: true },
    files: { "plugins/useful-skills.js": "a".repeat(64) },
    ...overrides,
  };
}

/** An installed runtime tree `<scopeRoot>/plugins/useful-skills` with an install record. */
async function installedRuntime(scopeRoot, recordValue = record(scopeRoot)) {
  const runtimeRoot = path.join(scopeRoot, "plugins", "useful-skills");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(installRecordPath(scopeRoot), JSON.stringify(recordValue));
  return runtimeRoot;
}

test("config and data dirs follow absolute XDG variables, else the home directory", () => {
  const home = "/home/tester";
  assert.equal(opencodeConfigDir({ HOME: home }), "/home/tester/.config/opencode");
  assert.equal(opencodeConfigDir({ HOME: home, XDG_CONFIG_HOME: "/xdg/config" }), "/xdg/config/opencode");
  assert.equal(opencodeConfigDir({ HOME: home, XDG_CONFIG_HOME: "relative/config" }), "/home/tester/.config/opencode");
  assert.equal(opencodeConfigDir({ HOME: home, OPENCODE_CONFIG_DIR: "/elsewhere" }), "/home/tester/.config/opencode");

  assert.equal(defaultDataDir({ HOME: home }), "/home/tester/.local/share/opencode/useful-skills");
  assert.equal(defaultDataDir({ HOME: home, XDG_DATA_HOME: "/xdg/data" }), "/xdg/data/opencode/useful-skills");
});

test("scope roots: user is the config dir, project is <cwd>/.opencode, anything else is refused", () => {
  const environment = { HOME: "/home/tester", XDG_CONFIG_HOME: "/xdg/config" };
  assert.equal(scopeRootFor({ scope: "user", cwd: "/work/repo", environment }), "/xdg/config/opencode");
  assert.equal(scopeRootFor({ scope: "project", cwd: "/work/repo", environment }), "/work/repo/.opencode");
  assert.throws(() => scopeRootFor({ scope: "global", cwd: "/work/repo", environment }), /--scope must be user or project/);
  assert.equal(installRecordPath("/x/opencode"), "/x/opencode/plugins/useful-skills/install-record.json");
});

test("an install record reads back when valid and is absent when missing", async t => {
  const root = await temporaryRoot(t);
  assert.equal(readInstallRecord(installRecordPath(root)), null);

  await installedRuntime(root);
  assert.deepEqual(readInstallRecord(installRecordPath(root)), record(root));
});

test("an untrustworthy install record is refused", async t => {
  const root = await temporaryRoot(t);
  const file = installRecordPath(root);
  await installedRuntime(root);

  const invalid = [
    { files: { "../escape.js": "a".repeat(64) } },
    { files: { "/absolute.js": "a".repeat(64) } },
    { files: { "plugins/x.js": "not-a-digest" } },
    { dataDir: "relative/data" },
    { scope: "global" },
    { schema: 2 },
    // Only stable x.y.z versions are accepted; the version is printed by status and uninstall.
    { version: "1.2.3-beta.1" },
    { version: "1.2" },
    { version: "1.2.3\u001b]0;owned\u0007" },
    // No string field may carry a terminal control character (C0, DEL or C1).
    { scopeRoot: `${root}\u001b[2J` },
    { dataDir: "/data/\u009b31m" },
    { configFile: "/cfg/opencode.json\u007f" },
    { mcpEntry: { type: "local", command: ["node", "/x/\u0000.js"], enabled: true } },
    { mcpEntry: { "type\n": "local" } },
    { files: { "plugins/\u001bx.js": "a".repeat(64) } },
    { configCreated: "yes" },
  ];
  for (const overrides of invalid) {
    await writeFile(file, JSON.stringify(record(root, overrides)));
    assert.throws(() => readInstallRecord(file), /unexpected format/, JSON.stringify(overrides));
  }

  await writeFile(file, JSON.stringify(record(root, { configCreated: true })));
  assert.equal(readInstallRecord(file).configCreated, true);

  await writeFile(file, "{ not json");
  assert.throws(() => readInstallRecord(file), /not valid JSON/);

  await writeFile(file, " ".repeat(1024 * 1024 + 1));
  assert.throws(() => readInstallRecord(file), /too large/);

  const target = path.join(root, "elsewhere.json");
  await writeFile(target, JSON.stringify(record(root)));
  await rm(file);
  await symlink(target, file);
  assert.throws(() => readInstallRecord(file), /must not be a symbolic link/);
});

test("runtimeInstall finds the record of an installed runtime tree only", async t => {
  const root = await temporaryRoot(t);
  const runtimeRoot = await installedRuntime(root);

  assert.deepEqual(runtimeInstall(runtimeRoot), { scopeRoot: root, record: record(root) });
  assert.equal(runtimeInstall(RUNTIME_ROOT), null, "a checkout is not an installed runtime");

  const unrecorded = path.join(root, "other", "plugins", "useful-skills");
  await mkdir(unrecorded, { recursive: true });
  assert.equal(runtimeInstall(unrecorded), null);

  await writeFile(installRecordPath(root), JSON.stringify(record(path.join(root, "moved"))));
  assert.throws(() => runtimeInstall(runtimeRoot), /different location/);
});

test("the data dir comes from an absolute USEFUL_SKILLS_DATA, then the install record", async t => {
  const root = await temporaryRoot(t);
  const runtimeRoot = await installedRuntime(root);

  assert.equal(resolveDataDir({ environment: {}, runtimeRoot }), path.join(root, "data"));
  assert.equal(resolveDataDir({ environment: { USEFUL_SKILLS_DATA: "/override" }, runtimeRoot }), "/override");
  assert.match(resolveDataDir({ environment: { USEFUL_SKILLS_DATA: "relative" }, runtimeRoot }).reason, /absolute path/);
  assert.match(resolveDataDir({ environment: {}, runtimeRoot: RUNTIME_ROOT }).reason, /install --host opencode/);
});

test("bundleVersion reads the OpenCode package manifest of a runtime tree or a checkout", async t => {
  const root = await temporaryRoot(t);
  const checkout = JSON.parse(await readFile(path.join(RUNTIME_ROOT, "opencode", "package.json"), "utf8"));
  assert.equal(bundleVersion(RUNTIME_ROOT), checkout.version);

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "useful-skills-opencode", version: "9.8.7" }));
  assert.equal(bundleVersion(root), "9.8.7");

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
  assert.throws(() => bundleVersion(root), /Cannot read/);
});

test("printableText replaces control characters with spaces and keeps newlines", () => {
  assert.equal(printableText("a\u001b[31mb\nc\u009bd\te\u007f\r"), "a [31mb\nc d e  ");
  assert.equal(printableText("plain/path ünï"), "plain/path ünï");
});
