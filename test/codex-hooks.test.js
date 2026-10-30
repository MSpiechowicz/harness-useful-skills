import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codexHint, hookLocations } from "../codex/hooks.js";
import { codexCommand, codexSearchInput } from "../codex/hook-input.js";
import { hookCommand } from "../codex/hooks-config.js";
import { installCodex } from "../codex/install.js";
import { inspectCodexInstall } from "../codex/install-status.js";
import { uninstallCodex } from "../codex/uninstall.js";
import { searchTerm } from "../code-hint.js";
import { writeAtomic } from "../model-roles.js";
import { writeWorkflowSetting } from "../workflow-settings.js";
import { createCodexSandbox, writePackage } from "./helpers/codex-install-fixture.js";

const HOOK = fileURLToPath(new URL("../codex/hooks.js", import.meta.url));
const pre = (tool_input, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/work", tool_name: "Bash", tool_input, ...extra });

test("Codex shell inputs map to the same search term as Claude Bash", () => {
  const term = (input) => { const adapted = codexSearchInput(input); return adapted && searchTerm(adapted); };
  assert.equal(term(pre({ command: "rg -n handleThing src" })), "handleThing");
  assert.equal(term(pre({ command: ["bash", "-lc", "rg -n handleThing src"] })), "handleThing");
  assert.equal(term(pre({ command: ["/bin/zsh", "-c", "cat a | grep Widget"] })), "Widget");
  assert.equal(term(pre({ command: ["rg", "Widget", "src"] })), "Widget");
  assert.equal(term(pre({ cmd: "git grep -n parseConfig" }, { tool_name: "exec_command" })), "parseConfig");
  assert.equal(term(pre({ command: ["grep", "two words", "x"] })), undefined);
  assert.equal(term(pre({ command: ["ls", "-la"] })), undefined);
  assert.equal(term(pre({ command: "ls -la" })), undefined);
});

test("Codex adapter ignores other tools, events and shapes, and never expands anything", () => {
  assert.equal(codexSearchInput(pre({ command: "rg abc" }, { tool_name: "apply_patch" })), undefined);
  assert.equal(codexSearchInput(pre({ command: "rg abc" }, { hook_event_name: "PostToolUse" })), undefined);
  assert.equal(codexSearchInput(pre({ command: 5 })), undefined);
  assert.equal(codexSearchInput(pre({ command: [] })), undefined);
  assert.equal(codexSearchInput(pre({ command: ["bash", "-lc"] })), undefined);
  assert.equal(codexSearchInput(pre({ command: [1, 2] })), undefined);
  assert.equal(codexSearchInput(null), undefined);
  assert.equal(searchTerm(codexSearchInput(pre({ command: ["bash", "-lc", "rg $(touch /x) src"] }))), undefined);
  assert.equal(searchTerm(codexSearchInput(pre({ command: ["rg", "$(touch /x)", "src"] }))), undefined);
  assert.equal(codexCommand({ command: ["echo", "it's"] }), "'echo' 'it'\\''s'");
});

function runtimeBox(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "us-codex-hook-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const project = path.join(root, "repo");
  mkdirSync(path.join(codexHome, "harness-useful-skills", "data"), { recursive: true });
  chmodSync(path.join(codexHome, "harness-useful-skills", "data"), 0o700);
  mkdirSync(project);
  const calls = [];
  const services = {
    resolve: () => "/fake/harness-memory",
    execFile: (file, args, options, done) => { calls.push(args); done(null, JSON.stringify({ hint: `use code_symbol for ${args[args.indexOf("--query") + 1]}` })); },
  };
  const locations = { codexHome, dataDir: path.join(codexHome, "harness-useful-skills", "data") };
  return { root, codexHome, project, calls, services, locations, input: (command, extra) => pre({ command }, { cwd: project, ...extra }) };
}

test("hint comes back for a Codex shell search, once per term, with 0600 state in the runtime data dir", async (t) => {
  const box = runtimeBox(t);
  const run = (command) => codexHint(box.input(command), { locations: box.locations, services: box.services });
  assert.equal(await run(["bash", "-lc", "rg -n alphaName src"]), "use code_symbol for alphaName");
  assert.equal(await run("rg alphaName"), undefined);
  assert.equal(box.calls.length, 1);
  assert.equal(statSync(path.join(box.locations.dataDir, "code-hint-state.json")).mode & 0o777, 0o600);
  for (let i = 0; i < 7; i += 1) await run(`grep -rn name${i}x src`);
  assert.equal(box.calls.length, 5);
});

test("silent for failures, other tools, non-identifiers and a disabled code-graph stage", async (t) => {
  const box = runtimeBox(t);
  const run = (input, services = box.services) => codexHint(input, { locations: box.locations, services });
  assert.equal(await run(box.input("ls -la")), undefined);
  assert.equal(await run(box.input("rg 'a b' src")), undefined);
  assert.equal(await run(box.input("rg abcdef", { tool_name: "apply_patch" })), undefined);
  assert.equal(await run(box.input("rg firstTerm"), { ...box.services, resolve: () => undefined }), undefined);
  assert.equal(await run(box.input("rg secondTerm"), { ...box.services, execFile: (a, b, c, done) => done(new Error("x")) }), undefined);
  assert.equal(await run(pre({ command: "rg thirdTerm" }, { cwd: "relative" })), undefined);
  assert.equal(box.calls.length, 0);

  await writeWorkflowSetting({ agentDir: box.locations.dataDir, cwd: box.project, key: "code-graph", enabled: false });
  assert.equal(await run(box.input("rg offTerm")), undefined);
  assert.equal(box.calls.length, 0);
  await writeWorkflowSetting({ agentDir: box.locations.dataDir, cwd: box.project, key: "code-graph", enabled: true });
  assert.equal(await run(box.input("rg offTerm")), "use code_symbol for offTerm");
});

test("the hook process prints only additionalContext, and nothing on bad input or a disabled stage", async (t) => {
  const box = runtimeBox(t);
  const bin = path.join(box.root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "harness-memory"), '#!/bin/sh\necho \'{"hint":"try code_symbol for it"}\'\n');
  chmodSync(path.join(bin, "harness-memory"), 0o755);
  const env = { PATH: bin, HOME: path.join(box.root, "home"), CODEX_HOME: box.codexHome, USEFUL_SKILLS_DATA: box.locations.dataDir };
  const run = (input, raw) => spawnSync(process.execPath, [HOOK], { input: raw ?? JSON.stringify(input), encoding: "utf8", env });

  const ok = run(box.input(["bash", "-lc", "rg -n someSymbol"]));
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "try code_symbol for it" } });

  for (const result of [run(undefined, "not json"), run(undefined, ""), run(box.input("ls"), undefined)]) {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }

  await writeWorkflowSetting({ agentDir: box.locations.dataDir, cwd: box.project, key: "code-graph", enabled: false });
  assert.equal(run(box.input("rg otherSymbol", { session_id: "s2" })).stdout, "");
});

test("an installed runtime finds its Codex home and data directory from its own location", () => {
  const file = "/h/.codex/harness-useful-skills/runtime/codex/hooks.js";
  assert.deepEqual(hookLocations({}, file), { codexHome: "/h/.codex", dataDir: "/h/.codex/harness-useful-skills/data" });
});

// ---- installer registration ----

function setup(t) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  const install = () => installCodex({ environment: box.environment, packageRoot: box.packageRoot });
  const uninstall = () => uninstallCodex({ environment: box.environment });
  const hooksFile = box.at("hooks.json");
  const read = () => readFileSync(hooksFile, "utf8");
  return { ...box, install, uninstall, hooksFile, read };
}

const ours = (box) => ({ type: "command", command: hookCommand(realpathSync(box.codexHome)).command, timeout: 5 });
const count = (box) => (JSON.parse(box.read()).hooks?.PreToolUse ?? []).flatMap((group) => group.hooks).filter((hook) => hook.command === ours(box).command).length;

test("install adds exactly one PreToolUse hook entry, again and again", async (t) => {
  const box = setup(t);
  const first = await box.install();
  assert.match(first.message, /Code-graph hint hook registered in .*hooks\.json\. Codex skips it until you review and trust it: open \/hooks/);
  assert.deepEqual(JSON.parse(box.read()), { hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [ours(box)] }] } });
  assert.match(ours(box).command, /^node ".*\/harness-useful-skills\/runtime\/codex\/hooks\.js"$/);

  const text = box.read();
  const second = await box.install();
  assert.match(second.message, /already registered/);
  assert.equal(box.read(), text);
  assert.equal(count(box), 1);
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /Code-graph hint hook: registered in hooks\.json/);
});

test("install keeps the user's other hooks and keys, and uninstall removes only ours", async (t) => {
  const box = setup(t);
  const mine = { description: "mine", hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "echo mine" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } };
  const original = `${JSON.stringify(mine, null, 2)}\n`;
  writeFileSync(box.hooksFile, original);

  await box.install();
  const merged = JSON.parse(box.read());
  assert.equal(merged.description, "mine");
  assert.deepEqual(merged.hooks.Stop, mine.hooks.Stop);
  assert.deepEqual(merged.hooks.PreToolUse[0], mine.hooks.PreToolUse[0]);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(existsSync(box.at("hooks.json.useful-skills.bak")), false);

  const result = await box.uninstall();
  assert.match(result.message, /Removed the code-graph hint hook from/);
  assert.equal(box.read(), original);
  assert.equal(existsSync(box.at("harness-useful-skills", "install-record.json")), false);
});

test("uninstall deletes a hooks.json that only held our entry, and leaves a file without it alone", async (t) => {
  const box = setup(t);
  await box.install();
  await box.uninstall();
  assert.equal(existsSync(box.hooksFile), false);

  const box2 = setup(t);
  await box2.install();
  const other = '{\n    "hooks": {}\n}';
  writeFileSync(box2.hooksFile, other);
  const result = await box2.uninstall();
  assert.doesNotMatch(result.message, /hint hook/);
  assert.equal(box2.read(), other);
});

test("a hand-formatted hooks.json is backed up once before the rewrite, and its content survives", async (t) => {
  const box = setup(t);
  const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}, "x": 1}';
  writeFileSync(box.hooksFile, original);
  await box.install();
  assert.equal(readFileSync(box.at("hooks.json.useful-skills.bak"), "utf8"), original);
  const data = JSON.parse(box.read());
  assert.equal(data.x, 1);
  assert.equal(data.hooks.Stop.length, 1);
  assert.equal(count(box), 1);
});

test("a hooks.json that cannot be used is reported and the rest of the install still completes", async (t) => {
  const box = setup(t);
  writeFileSync(box.hooksFile, "{ not json");
  const result = await box.install();
  assert.match(result.message, /Code-graph hint hook not registered \(.*is not valid JSON\)/);
  assert.equal(box.read(), "{ not json");
  assert.ok(existsSync(box.at("harness-useful-skills", "install-record.json")));

  writeFileSync(box.hooksFile, "[]");
  assert.match((await box.install()).message, /must hold a JSON object/);
  rmSync(box.hooksFile);
  const target = path.join(box.root, "elsewhere.json");
  writeFileSync(target, "{}");
  symlinkSync(target, box.hooksFile);
  assert.match((await box.install()).message, /symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "{}");
});

test("config.toml is never touched by the hook registration", async (t) => {
  const box = setup(t);
  await box.install();
  assert.doesNotMatch(readFileSync(box.at("config.toml"), "utf8"), /hooks/);
});

test("a private hooks.json keeps its mode through the rewrite, which is created with that mode from the start", async (t) => {
  const box = setup(t);
  writeFileSync(box.hooksFile, `${JSON.stringify({ description: "mine" }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(box.hooksFile, 0o600);
  await box.install();
  assert.equal(statSync(box.hooksFile).mode & 0o777, 0o600);

  // writeAtomic itself opens the temporary file with the requested mode: no 0644 window, whatever the later chmod does.
  const dir = mkdtempSync(path.join(os.tmpdir(), "us-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "x.json");
  writeAtomic(file, "{}", 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeAtomic(file, "{}");
  assert.equal(statSync(file).mode & 0o777, 0o644 & ~process.umask());
});

test("a Codex shell search of several names gets a hint for the first known name", async (t) => {
  const box = runtimeBox(t);
  assert.equal(await codexHint(box.input("rg -n 'alphaName|betaName' src"), { locations: box.locations, services: box.services }), "use code_symbol for alphaName");
});
