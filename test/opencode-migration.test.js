import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { LEGACY_DATA_DIRECTORY, LEGACY_MCP_SERVER_NAME, LEGACY_OPENCODE_ENTRY, LEGACY_OPENCODE_RUNTIME } from "../legacy-names.js";
import { installOpenCode } from "../opencode/install.js";
import { sha256 } from "../opencode/install-files.js";
import { inspectOpenCodeInstall } from "../opencode/install-status.js";
import { uninstallOpenCode } from "../opencode/uninstall.js";
import { createInstallSandbox, writeBundle } from "./helpers/opencode-install-fixture.js";

const NEW_MCP = "harness-useful-skills";

function setup(t) {
  const box = createInstallSandbox();
  t.after(box.cleanup);
  writeBundle(box.bundleRoot);
  const at = (...parts) => path.join(box.configDir, ...parts);
  const options = { scope: "user", cwd: box.cwd, environment: box.environment };
  return {
    ...box,
    at,
    legacyData: path.join(path.dirname(box.dataDir), LEGACY_DATA_DIRECTORY),
    install: () => installOpenCode({ ...options, bundleRoot: box.bundleRoot }),
    uninstall: () => uninstallOpenCode(options),
    doctor: () => inspectOpenCodeInstall(options).text,
    json: file => JSON.parse(readFileSync(file, "utf8")),
  };
}

function put(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode) chmodSync(file, mode);
}

/** An OpenCode install as 0.3.x wrote it: files, record, MCP entry, data, settings and an edited models file. */
function writeEarlierInstall(box, { configText } = {}) {
  const files = {
    [`plugins/${LEGACY_OPENCODE_ENTRY}`]: "export { default } from \"./useful-skills/opencode/entry.js\";\n",
    [`plugins/${LEGACY_OPENCODE_RUNTIME}/package.json`]: "{\"name\":\"useful-skills-opencode\",\"version\":\"0.3.13\"}\n",
    [`plugins/${LEGACY_OPENCODE_RUNTIME}/opencode/mcp-server.js`]: "// earlier mcp\n",
    "skills/us-plan/SKILL.md": "---\nname: us-plan\n---\nearlier plan\n",
    "commands/useful-skills.md": "earlier fallback\n",
  };
  const record = {};
  for (const [rel, text] of Object.entries(files)) {
    put(box.at(...rel.split("/")), text);
    record[rel] = sha256(text);
  }

  const mcpEntry = { type: "local", command: ["node", box.at("plugins", LEGACY_OPENCODE_RUNTIME, "opencode", "mcp-server.js")], enabled: true, timeout: 600000 };
  put(box.at("opencode.json"), configText ?? `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "a/b", mcp: { [LEGACY_MCP_SERVER_NAME]: mcpEntry, other: { type: "remote" } } }, null, 2)}\n`);

  put(box.at("plugins", LEGACY_OPENCODE_RUNTIME, "install-record.json"), `${JSON.stringify({
    schema: 1,
    version: "0.3.13",
    scope: "user",
    scopeRoot: box.configDir,
    dataDir: box.legacyData,
    configFile: box.at("opencode.json"),
    mcpEntry,
    configCreated: false,
    files: record,
  }, null, 2)}\n`);

  put(path.join(box.legacyData, LEGACY_DATA_DIRECTORY, "memory", "abc", "notes.md"), "remembered\n", 0o600);
  put(path.join(box.legacyData, LEGACY_DATA_DIRECTORY, "dependencies", "lock", "venv", "python"), "#!/old\n");
  put(box.at(LEGACY_DATA_DIRECTORY, "models.yml"), "modelRoles:\n  review: anthropic/claude-sonnet-5-5:high\n");
  put(box.at(LEGACY_DATA_DIRECTORY, "workflow-settings", "plan.json"), "false\n", 0o600);
  for (const directory of [box.legacyData, path.join(box.legacyData, LEGACY_DATA_DIRECTORY), path.join(box.legacyData, LEGACY_DATA_DIRECTORY, "memory"), path.join(box.legacyData, LEGACY_DATA_DIRECTORY, "memory", "abc"), box.at(LEGACY_DATA_DIRECTORY), box.at(LEGACY_DATA_DIRECTORY, "workflow-settings")]) {
    chmodSync(directory, 0o700);
  }
  return { files, mcpEntry };
}

test("installing over a 0.3.x install replaces it: old plugin files and MCP entry go, other config stays", t => {
  const box = setup(t);
  writeEarlierInstall(box);

  const result = box.install();

  assert.equal(result.actionRequired, false);
  assert.equal(existsSync(box.at("plugins", LEGACY_OPENCODE_ENTRY)), false);
  assert.equal(existsSync(box.at("plugins", LEGACY_OPENCODE_RUNTIME)), false, "the earlier runtime folder and its record are gone");
  assert.ok(existsSync(box.at("plugins", "harness-useful-skills.js")));
  assert.ok(existsSync(box.at("plugins", "harness-useful-skills", "install-record.json")));

  const config = box.json(box.at("opencode.json"));
  assert.equal(config.model, "a/b");
  assert.deepEqual(config.mcp.other, { type: "remote" });
  assert.equal(Object.hasOwn(config.mcp, LEGACY_MCP_SERVER_NAME), false);
  assert.equal(config.mcp[NEW_MCP].command[1], box.at("plugins", "harness-useful-skills", "opencode", "mcp-server.js"));
  assert.match(result.message, new RegExp(`Removed mcp\\.${LEGACY_MCP_SERVER_NAME} from`));

  assert.equal(readFileSync(box.at("skills", "us-plan", "SKILL.md"), "utf8").includes("Plan 1.0.0"), true, "a shared file that was unchanged is replaced");
  assert.equal(readFileSync(box.at("commands", "useful-skills.md"), "utf8"), "Fallback\n");
});

test("the earlier data, settings and models file move to the new names without losing anything", t => {
  const box = setup(t);
  writeEarlierInstall(box);

  box.install();

  assert.equal(existsSync(box.legacyData), false);
  assert.equal(readFileSync(path.join(box.dataDir, "harness-useful-skills", "memory", "abc", "notes.md"), "utf8"), "remembered\n");
  assert.equal(existsSync(path.join(box.dataDir, "harness-useful-skills", "dependencies")), false, "the environment cache is rebuilt, not moved");
  assert.equal(existsSync(box.at(LEGACY_DATA_DIRECTORY)), false);
  assert.equal(readFileSync(box.at("harness-useful-skills", "models.yml"), "utf8"), "modelRoles:\n  review: anthropic/claude-sonnet-5-5:high\n");
  assert.equal(readFileSync(box.at("harness-useful-skills", "workflow-settings", "plan.json"), "utf8"), "false\n");
  assert.equal(box.json(box.at("plugins", "harness-useful-skills", "install-record.json")).dataDir, box.dataDir);

  const agent = readFileSync(box.at("agents", "us-reviewer.md"), "utf8");
  assert.match(agent, /model: "anthropic\/claude-sonnet-5-5"/, "the user's model choice survived the rename");
});

test("an earlier runtime file the user edited stays, with a note, and the new install still completes", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  const edited = box.at("plugins", LEGACY_OPENCODE_RUNTIME, "opencode", "mcp-server.js");
  writeFileSync(edited, "// my change\n");

  const result = box.install();

  assert.equal(readFileSync(edited, "utf8"), "// my change\n");
  assert.equal(existsSync(box.at("plugins", LEGACY_OPENCODE_ENTRY)), false, "unchanged earlier files are removed");
  assert.match(result.message, /Left a stale file from an earlier install in place: .*mcp-server\.js \(modified since it was installed\)/);
  assert.match(box.doctor(), /Earlier install: .*is still there/);
});

test("an earlier MCP entry the user changed is left alone and the new entry is added", t => {
  const box = setup(t);
  const { mcpEntry } = writeEarlierInstall(box);
  const changed = { ...mcpEntry, timeout: 1 };
  put(box.at("opencode.json"), `${JSON.stringify({ mcp: { [LEGACY_MCP_SERVER_NAME]: changed } })}\n`);

  const result = box.install();

  const config = box.json(box.at("opencode.json"));
  assert.deepEqual(config.mcp[LEGACY_MCP_SERVER_NAME], changed);
  assert.ok(config.mcp[NEW_MCP]);
  assert.match(result.message, new RegExp(`Left mcp\\.${LEGACY_MCP_SERVER_NAME} in .*not what Useful Skills wrote`));
  assert.match(box.doctor(), new RegExp(`still defines mcp\\.${LEGACY_MCP_SERVER_NAME}`));
});

test("a shared file the user edited makes the install refuse before anything is changed", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  writeFileSync(box.at("skills", "us-plan", "SKILL.md"), "my skill\n");
  const before = readdirSync(box.configDir, { recursive: true }).sort();

  assert.throws(() => box.install(), /us-plan.*modified since it was installed/s);

  assert.deepEqual(readdirSync(box.configDir, { recursive: true }).sort(), before);
  assert.ok(existsSync(box.at("plugins", LEGACY_OPENCODE_ENTRY)));
});

test("a models file edited in both places keeps both and says so", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  put(box.at("harness-useful-skills", "models.yml"), "modelRoles:\n  default: inherit\n");

  const result = box.install();

  assert.equal(readFileSync(box.at("harness-useful-skills", "models.yml"), "utf8"), "modelRoles:\n  default: inherit\n");
  assert.equal(readFileSync(box.at(LEGACY_DATA_DIRECTORY, "models.yml"), "utf8"), "modelRoles:\n  review: anthropic/claude-sonnet-5-5:high\n");
  assert.match(result.message, /Left .*useful-skills\/models\.yml in place: it differs from the file at the new location/);
});

test("installing again after the migration changes nothing", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  box.install();

  const again = box.install();

  assert.match(again.message, /already installed/);
  assert.doesNotMatch(again.message, /Removed mcp|Left /);
});

test("doctor reports an earlier install that has not been replaced yet", t => {
  const box = setup(t);
  writeEarlierInstall(box);

  const report = box.doctor();

  assert.match(report, /not installed/);
  assert.match(report, /Earlier install: .*is still there\. Run `\.\/useful-skills install --host opencode`/);
  assert.match(report, new RegExp(`Earlier install: .*opencode\\.json still defines mcp\\.${LEGACY_MCP_SERVER_NAME}`));
  assert.match(report, /Earlier install: .*useful-skills still exists/);

  box.install();
  assert.doesNotMatch(box.doctor(), /Earlier install/);
});

test("uninstall removes a 0.3.x install by its own record", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  const user = box.at("skills", "mine", "SKILL.md");
  put(user, "mine\n");

  const { message } = box.uninstall();

  assert.equal(existsSync(box.at("plugins")), false);
  assert.equal(existsSync(box.at("commands")), false);
  assert.equal(readFileSync(user, "utf8"), "mine\n");
  const config = box.json(box.at("opencode.json"));
  assert.deepEqual(Object.keys(config.mcp), ["other"]);
  assert.match(message, /Uninstalled Useful Skills 0\.3\.13 from OpenCode/);
  assert.ok(message.includes(box.legacyData), "the earlier data directory is listed as kept");
});

test("uninstall removes both the old and the new install when both are recorded", t => {
  const box = setup(t);
  writeEarlierInstall(box);
  box.install();
  // A half-finished migration: the earlier record and its server entry are still there next to the new install.
  writeEarlierInstall(box);
  const { message } = box.uninstall();

  assert.equal(existsSync(box.at("plugins")), false, message);
  const config = box.json(box.at("opencode.json"));
  assert.equal(Object.hasOwn(config.mcp, NEW_MCP), false);
  assert.equal(Object.hasOwn(config.mcp, LEGACY_MCP_SERVER_NAME), false);
  assert.match(message, /Uninstalled Useful Skills 1\.0\.0 and 0\.3\.13/);
});
