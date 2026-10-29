import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildRelease, codexStubBin, runInstaller, skip, toolsPath } from "./helpers/install-script-fixture.js";

const VERSION = { HARNESS_SKILLS_VERSION: "v1.2.3" };
const CODEX = { ...VERSION, HARNESS_SKILLS_HOST: "codex" };

test("HARNESS_SKILLS_HOST=codex runs the release installer for Codex without a scope", { skip }, async () => {
  const { archive, top } = await buildRelease({ codex: true });
  const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: CODEX });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(outcome.downloads, ["https://codeload.github.com/MSpiechowicz/harness-useful-skills/tar.gz/refs/tags/v1.2.3"]);
  assert.equal(path.basename(path.dirname(outcome.recorded.argv[0])), top);
  assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "codex"]);
  assert.match(outcome.stdout, /Installing Harness Skills v1\.2\.3 for Codex/);
  assert.match(outcome.stdout, /Restart Codex to load Harness Skills\./);
  assert.doesNotMatch(outcome.stdout, /OpenCode/);
  assert.deepEqual(outcome.leftovers, []);
});

test("a Codex release from before the names were unified is refused", { skip }, async () => {
  const { archive } = await buildRelease({ codex: true, earlier: true });
  const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: CODEX });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /has no Codex adapter/);
  assert.equal(outcome.recorded, null);
});

test("an unset, empty or opencode host keeps the OpenCode installer arguments", { skip }, async () => {
  const { archive } = await buildRelease({ codex: true });
  for (const env of [VERSION, { ...VERSION, HARNESS_SKILLS_HOST: "" }, { ...VERSION, HARNESS_SKILLS_HOST: "opencode" }]) {
    const outcome = await runInstaller({ archive, env });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(outcome.recorded.argv.slice(1), ["install", "--host", "opencode", "--scope", "user"]);
    assert.match(outcome.stdout, /Restart OpenCode to load Harness Skills\./);
  }
});

test("opencode does not need the codex command", { skip }, async () => {
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, path: await toolsPath(), env: { ...VERSION, HARNESS_SKILLS_HOST: "opencode" } });
  assert.equal(outcome.status, 0, outcome.stderr);
});

test("an unknown HARNESS_SKILLS_HOST is refused before any download", { skip }, async () => {
  for (const host of ["foo", "Codex", "codex\n", "opencode\n", "codex opencode", "codex;id", "$(id)", "\u001b[31mred"]) {
    const outcome = await runInstaller({ bin: await codexStubBin(), env: { ...VERSION, HARNESS_SKILLS_HOST: host } });
    assert.notEqual(outcome.status, 0, JSON.stringify(host));
    assert.match(outcome.stderr, /unexpected HARNESS_SKILLS_HOST/, JSON.stringify(host));
    assert.doesNotMatch(outcome.stderr, /\u001b\[31m/, "escapes are not echoed");
    assert.deepEqual(outcome.downloads, [], JSON.stringify(host));
    assert.equal(outcome.recorded, null);
    assert.deepEqual(outcome.leftovers, []);
  }
});

test("a missing codex command fails early, before any download", { skip }, async () => {
  const outcome = await runInstaller({ path: await toolsPath(), env: CODEX });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /needs the 'codex' command/);
  assert.deepEqual(outcome.downloads, []);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("a release without the Codex adapter is refused and runs nothing", { skip }, async () => {
  // An OpenCode-only release, like every release up to v0.3.12.
  const { archive } = await buildRelease();
  const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: CODEX });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /this release \(v1\.2\.3\) has no Codex adapter .*use a newer release/);
  assert.equal(outcome.recorded, null);
  assert.deepEqual(outcome.leftovers, []);
});

test("each missing Codex file is refused with the no-adapter message", { skip }, async () => {
  for (const file of [
    ["plugins", "codex", ".codex-plugin", "plugin.json"],
    ["plugins", "codex-runtime", "harness-useful-skills", "codex", "mcp-server.js"],
    [".agents", "plugins", "marketplace.json"],
  ]) {
    const { archive } = await buildRelease({ codex: true, extra: (root) => rm(path.join(root, ...file)) });
    const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: CODEX });
    assert.notEqual(outcome.status, 0, file.join("/"));
    assert.match(outcome.stderr, new RegExp(`has no Codex adapter \\(missing ${file.join("/").replace(/\./g, "\\.")}\\)`));
    assert.equal(outcome.recorded, null);
    assert.deepEqual(outcome.leftovers, []);
  }
});

test("a Codex manifest version that differs from the tag is refused", { skip }, async () => {
  const { archive } = await buildRelease({
    codex: true,
    extra: async (root) => {
      await writeFile(path.join(root, "plugins", "codex", ".codex-plugin", "plugin.json"), JSON.stringify({ version: "1.2.2" }));
    },
  });
  const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: CODEX });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /plugin\.json has version 1\.2\.2, expected 1\.2\.3/);
  assert.equal(outcome.recorded, null);
});

test("the exit code of the Codex installer is propagated and the download is removed", { skip }, async () => {
  const { archive } = await buildRelease({ codex: true });
  const outcome = await runInstaller({ archive, bin: await codexStubBin(), env: { ...CODEX, INSTALLER_EXIT: "5" } });
  assert.equal(outcome.status, 5);
  assert.match(outcome.stderr, /installer failed \(exit 5\)/);
  assert.doesNotMatch(outcome.stdout, /Restart Codex/);
  assert.deepEqual(outcome.leftovers, []);
});
