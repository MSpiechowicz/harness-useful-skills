import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { installOpenCode } from "../opencode/install.js";
import { uninstallOpenCode } from "../opencode/uninstall.js";
import { createInstallSandbox, writeBundle } from "./helpers/opencode-install-fixture.js";

function setup(t) {
  const box = createInstallSandbox();
  t.after(box.cleanup);
  writeBundle(box.bundleRoot);
  const install = (scope = "user") => installOpenCode({ scope, cwd: box.cwd, environment: box.environment, bundleRoot: box.bundleRoot });
  const uninstall = (scope = "user") => uninstallOpenCode({ scope, cwd: box.cwd, environment: box.environment });
  return { ...box, install, uninstall, at: (...parts) => path.join(box.configDir, ...parts) };
}

test("uninstall removes everything it installed and keeps data, settings and model roles", (t) => {
  const box = setup(t);
  box.install();
  mkdirSync(box.at("harness-useful-skills", "workflow-settings"), { recursive: true });
  // Things OpenCode and the user own in the same directory must survive.
  writeFileSync(box.at(".gitignore"), "node_modules\n");
  writeFileSync(box.at("package.json"), "{}");
  mkdirSync(box.at("skills", "mine"), { recursive: true });
  writeFileSync(box.at("skills", "mine", "SKILL.md"), "mine\n");
  const config = JSON.parse(readFileSync(box.at("opencode.json"), "utf8"));
  writeFileSync(box.at("opencode.json"), JSON.stringify({ ...config, model: "a/b" }));

  const { message } = box.uninstall();

  assert.equal(existsSync(box.at("plugins")), false);
  assert.equal(existsSync(box.at("commands")), false);
  assert.deepEqual(readdirSync(box.at("skills")), ["mine"]);
  assert.equal(existsSync(box.at("agents")), false);
  assert.deepEqual(JSON.parse(readFileSync(box.at("opencode.json"), "utf8")), { $schema: config.$schema, model: "a/b" });
  assert.equal(readFileSync(box.at(".gitignore"), "utf8"), "node_modules\n");
  assert.equal(readFileSync(box.at("package.json"), "utf8"), "{}");
  assert.ok(existsSync(box.dataDir));
  assert.ok(existsSync(box.at("harness-useful-skills", "models.yml")));

  assert.match(message, /Uninstalled Useful Skills 1\.0\.0/);
  assert.ok(message.includes(box.dataDir));
  assert.ok(message.includes(box.at("harness-useful-skills", "models.yml")));
  assert.ok(message.includes(box.at("harness-useful-skills")));
  assert.match(message, /Restart OpenCode/);
});

test("uninstall leaves an edited file, a changed MCP entry and an agent the user took over", (t) => {
  const box = setup(t);
  box.install();
  writeFileSync(box.at("commands", "useful-skills.md"), "my edit\n");
  const config = JSON.parse(readFileSync(box.at("opencode.json"), "utf8"));
  config.mcp["harness-useful-skills"].timeout = 1;
  writeFileSync(box.at("opencode.json"), JSON.stringify(config));
  writeFileSync(box.at("agents", "us-scout.md"), "---\ndescription: mine\n---\nmy scout\n");

  const { message } = box.uninstall();

  assert.equal(readFileSync(box.at("commands", "useful-skills.md"), "utf8"), "my edit\n");
  assert.equal(readFileSync(box.at("agents", "us-scout.md"), "utf8"), "---\ndescription: mine\n---\nmy scout\n");
  assert.equal(JSON.parse(readFileSync(box.at("opencode.json"), "utf8")).mcp["harness-useful-skills"].timeout, 1);
  assert.equal(existsSync(box.at("agents", "us-planner.md")), false);
  assert.equal(existsSync(box.at("commands", "us-ignore-workflow.md")), false);
  assert.equal(existsSync(box.at("plugins", "harness-useful-skills", "install-record.json")), false);

  assert.ok(message.includes(box.at("commands", "useful-skills.md")));
  assert.ok(message.includes(box.at("agents", "us-scout.md")));
  assert.match(message, /Left mcp\.harness-useful-skills .* not what Useful Skills wrote/);
});

test("uninstall leaves a JSONC config with comments alone and tells the user what to remove", (t) => {
  const box = setup(t);
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(box.at("opencode.jsonc"), "{\n  // mine\n}\n");
  box.install();
  const commented = '{\n  // mine\n  "mcp": { "harness-useful-skills": {} }\n}\n';
  writeFileSync(box.at("opencode.jsonc"), commented);

  const { message } = box.uninstall();

  assert.equal(readFileSync(box.at("opencode.jsonc"), "utf8"), commented);
  assert.match(message, /Remove mcp\.harness-useful-skills yourself/);
  assert.match(message, /mcp-server\.js/);
});

test("uninstall without an install changes nothing and says so", (t) => {
  const box = setup(t);
  assert.match(box.uninstall().message, /not installed/);

  mkdirSync(box.at("skills"), { recursive: true });
  writeFileSync(box.at("skills", "keep.md"), "x\n");
  assert.match(box.uninstall().message, /not installed/);
  assert.equal(readFileSync(box.at("skills", "keep.md"), "utf8"), "x\n");
});

test("uninstall never follows a symlinked directory out of the scope, even when the contents match", (t) => {
  const box = setup(t);
  box.install();
  const outside = path.join(box.root, "outside-skills");
  cpSync(box.at("skills"), outside, { recursive: true });
  rmSync(box.at("skills"), { recursive: true });
  symlinkSync(outside, box.at("skills"));

  const { message } = box.uninstall();

  assert.ok(existsSync(path.join(outside, "us-plan", "SKILL.md")));
  assert.match(message, /symbolic link/);
  assert.equal(existsSync(box.at("plugins", "harness-useful-skills.js")), false, "the rest is still removed");
});

test("a project uninstall only touches the project's .opencode", (t) => {
  const box = setup(t);
  box.install("user");
  box.install("project");

  box.uninstall("project");

  assert.equal(existsSync(path.join(box.cwd, ".opencode", "plugins")), false);
  assert.equal(existsSync(path.join(box.cwd, ".opencode", "opencode.json")), false, "the project config the install created is deleted");
  assert.ok(existsSync(box.at("plugins", "harness-useful-skills.js")));
  assert.ok(JSON.parse(readFileSync(box.at("opencode.json"), "utf8")).mcp["harness-useful-skills"]);
});

test("uninstall deletes the opencode.json the install created once only $schema is left", (t) => {
  const box = setup(t);
  box.install();
  assert.ok(existsSync(box.at("opencode.json")));

  const { message } = box.uninstall();

  assert.equal(existsSync(box.at("opencode.json")), false);
  assert.match(message, /Removed .*opencode\.json: Useful Skills created it/);
});

test("uninstall keeps an opencode.json it did not create, or one that gained other settings", (t) => {
  const existing = setup(t);
  mkdirSync(existing.configDir, { recursive: true });
  writeFileSync(existing.at("opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
  existing.install();
  existing.uninstall();
  assert.deepEqual(JSON.parse(readFileSync(existing.at("opencode.json"), "utf8")), { $schema: "https://opencode.ai/config.json" });

  const edited = setup(t);
  edited.install();
  const config = JSON.parse(readFileSync(edited.at("opencode.json"), "utf8"));
  writeFileSync(edited.at("opencode.json"), JSON.stringify({ ...config, theme: "dark" }));
  edited.uninstall();
  assert.deepEqual(JSON.parse(readFileSync(edited.at("opencode.json"), "utf8")), { $schema: config.$schema, theme: "dark" });
});

test("uninstall refuses an install record with a crafted version and prints no control characters", (t) => {
  const box = setup(t);
  box.install();
  const recordFile = box.at("plugins", "harness-useful-skills", "install-record.json");
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  writeFileSync(recordFile, JSON.stringify({ ...record, version: "1.0.0\u001b[31m" }));

  assert.throws(() => box.uninstall(), /unexpected format/);
  assert.ok(existsSync(box.at("plugins", "harness-useful-skills.js")), "nothing was removed");

});

test("uninstall prints paths without control characters", (t) => {
  const box = setup(t);
  const environment = { ...box.environment, XDG_CONFIG_HOME: path.join(box.root, "evil\u001b[2Jconfig") };
  mkdirSync(path.join(environment.XDG_CONFIG_HOME, "opencode"), { recursive: true });

  const { message } = uninstallOpenCode({ scope: "user", cwd: box.cwd, environment });

  assert.match(message, /not installed .*evil \[2Jconfig/);
  assert.doesNotMatch(message, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
