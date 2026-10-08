import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { claudePluginDataDir } from "../claude/host-context.js";
import { assertNoWrites, directoryMarketplace, factsDirectory, fixture } from "./helpers/claude-doctor-fixture.js";

test("unresolvable plugin data directories are not checked and nothing is written", async t => {
  const outside = await fixture(t);
  const elsewhere = path.join(outside.root, "elsewhere");
  await mkdir(path.join(elsewhere, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(elsewhere, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "useful-skills" }));

  const wrongName = await fixture(t);
  await writeFile(path.join(wrongName.packageRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "other" }));

  const shallow = await fixture(t);

  const missing = await fixture(t);
  await rm(missing.dataDir, { recursive: true });

  const linked = await fixture(t);
  const target = path.join(linked.root, "real-data");
  await mkdir(target, { mode: 0o700 });
  await rm(linked.dataDir, { recursive: true });
  await symlink(target, linked.dataDir, "dir");

  const cases = [
    [outside, { packageRoot: elsewhere }, /not running from the Claude Code plugin cache/],
    [wrongName, {}, /does not match the plugin manifest name/],
    [shallow, { packageRoot: path.dirname(shallow.packageRoot) }, /not running from the Claude Code plugin cache/],
    [missing, {}, /data directory does not exist yet/],
    [linked, {}, /must be a real directory, not a symbolic link/],
  ];
  for (const [f, options, reason] of cases) {
    for (const argv of [["doctor"], ["doctor", "--check"]]) {
      const report = await f.run(argv, options);
      assert.equal(report.exitCode, 1, report.text);
      assert.match(report.text, /\nMemory: not checked — /);
      assert.match(report.text, reason);
      assert.match(report.text, /\nSettings\n/);
      assert.doesNotMatch(report.text, /\nSetup\n/);
    }
    assert.deepEqual(f.calls, { install: 0, build: 0 });
  }

  await assertNoWrites(outside);
  await assertNoWrites(wrongName);
  await assertNoWrites(shallow);
  assert.deepEqual(await readdir(target), []);
});

test("claudePluginDataDir resolves the data directory for an installed plugin", async t => {
  const f = await fixture(t);
  assert.deepEqual(await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: f.configDir }, packageRoot: f.packageRoot }), { dataDir: f.dataDir });

  const unreadable = await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: path.join(f.root, "absent") }, packageRoot: f.packageRoot });
  assert.match(unreadable.reason, /config directory cannot be resolved/);

  await rm(path.join(f.packageRoot, ".claude-plugin", "plugin.json"));
  const noManifest = await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: f.configDir }, packageRoot: f.packageRoot });
  assert.match(noManifest.reason, /Cannot read the installed plugin manifest/);

  const realManifest = path.join(f.root, "plugin.json");
  await writeFile(realManifest, JSON.stringify({ name: "useful-skills" }));
  await symlink(realManifest, path.join(f.packageRoot, ".claude-plugin", "plugin.json"));
  const linkedManifest = await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: f.configDir }, packageRoot: f.packageRoot });
  assert.deepEqual(linkedManifest, { reason: "Plugin manifest must not be a symbolic link." });
});

test("a directory marketplace install resolves its data directory and runs doctor setup", async t => {
  const f = await fixture(t);
  const pluginRepo = await directoryMarketplace(f);

  const located = await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: f.configDir }, packageRoot: pluginRepo });
  assert.deepEqual(located, { dataDir: f.dataDir });
  assert.equal(path.basename(located.dataDir), "useful-skills-useful-skills-local");

  const setup = await f.run(["doctor"], { packageRoot: pluginRepo });
  assert.equal(setup.exitCode, 0, setup.text);
  assert.match(setup.text, /\nSetup\n {2}Facts: created\n {2}Dependencies: installed\n {2}Graph: built \(1 nodes, 0 edges\)\n/);
  assert.deepEqual(f.calls, { install: 1, build: 1 });
  assert.equal((await stat(await factsDirectory(f))).isDirectory(), true);
});

test("directory marketplace installs that cannot be matched exactly are not checked and nothing is written", async t => {
  const notInstalled = await fixture(t);
  const notInstalledRepo = await directoryMarketplace(notInstalled, { installed: [] });

  const elsewhere = await fixture(t);
  await mkdir(path.join(elsewhere.root, "other-plugin"));
  const elsewhereRepo = await directoryMarketplace(elsewhere, { source: "../other-plugin" });

  const ambiguous = await fixture(t);
  const ambiguousRepo = await directoryMarketplace(ambiguous, { marketplaces: ["useful-skills-local", "useful-skills-copy"] });

  const malformed = await fixture(t);
  const malformedRepo = await directoryMarketplace(malformed);
  await writeFile(path.join(malformed.configDir, "plugins", "known_marketplaces.json"), "{not json");

  const linked = await fixture(t);
  const linkedRepo = await directoryMarketplace(linked);
  const knownFile = path.join(linked.configDir, "plugins", "known_marketplaces.json");
  const realKnown = path.join(linked.root, "known_marketplaces.json");
  await writeFile(realKnown, await readFile(knownFile));
  await rm(knownFile);
  await symlink(realKnown, knownFile);

  const oversized = await fixture(t);
  const oversizedRepo = await directoryMarketplace(oversized);
  await writeFile(path.join(oversized.configDir, "plugins", "installed_plugins.json"), " ".repeat(1024 * 1024 + 1));

  const cases = [
    [notInstalled, notInstalledRepo, /not running from the Claude Code plugin cache or an installed directory marketplace/],
    [elsewhere, elsewhereRepo, /not running from the Claude Code plugin cache or an installed directory marketplace/],
    [ambiguous, ambiguousRepo, /Ambiguous plugin install/],
    [malformed, malformedRepo, /known marketplaces list is not valid JSON/],
    [linked, linkedRepo, /known marketplaces list must not be a symbolic link/],
    [oversized, oversizedRepo, /installed plugins list is too large/],
  ];
  for (const [f, packageRoot, reason] of cases) {
    for (const argv of [["doctor"], ["doctor", "--check"]]) {
      const report = await f.run(argv, { packageRoot });
      assert.equal(report.exitCode, 1, report.text);
      assert.match(report.text, /\nMemory: not checked — /);
      assert.match(report.text, reason);
      assert.doesNotMatch(report.text, /\nSetup\n/);
    }
    assert.deepEqual(f.calls, { install: 0, build: 0 });
    await assertNoWrites(f);
  }
});

test("a FIFO in place of a Claude plugin state file is rejected without blocking", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const pluginRepo = await directoryMarketplace(f);
  const knownFile = path.join(f.configDir, "plugins", "known_marketplaces.json");
  await rm(knownFile);

  try {
    execFileSync("mkfifo", [knownFile], { stdio: "ignore" });
  } catch {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }

  const started = Date.now();
  const located = await claudePluginDataDir({ environment: { CLAUDE_CONFIG_DIR: f.configDir }, packageRoot: pluginRepo });
  assert.deepEqual(located, { reason: "Claude known marketplaces list must be a regular file." });
  assert.ok(Date.now() - started < 5_000);
});
