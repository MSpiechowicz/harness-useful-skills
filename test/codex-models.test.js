import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applyCodexModels, formatApplied } from "../codex/apply-models.js";
import { AGENT_ROLES } from "../codex/agents.js";
import { installCodex } from "../codex/install.js";
import { inspectCodexInstall } from "../codex/install-status.js";
import { DEFAULT_MODELS, parseCodexSelector, readCodexModels, renderCodexAgent } from "../codex/models.js";
import { readCodexRecord } from "../codex/paths.js";
import { parseModelsConfig } from "../model-roles.js";
import { sha256 } from "../opencode/install-files.js";
import { createCodexSandbox, listTree, writePackage } from "./helpers/codex-install-fixture.js";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function setup(t) {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  writePackage(box.packageRoot);
  // The sandbox package carries only a stub runtime: give it the real role templates the apply step reads.
  const modelsFile = box.at("harness-useful-skills", "models.yml");
  const agent = role => readFileSync(box.at("agents", `us-${role}.toml`), "utf8");
  return {
    ...box,
    modelsFile,
    agent,
    writeModels: text => {
      mkdirSync(path.dirname(modelsFile), { recursive: true });
      writeFileSync(modelsFile, text);
    },
    install: (options = {}) => installCodex({ environment: box.environment, packageRoot: box.packageRoot, ...options }),
    apply: () => applyCodexModels({ environment: box.environment }),
    record: () => readCodexRecord(box.at("harness-useful-skills", "install-record.json"), box.codexHome),
  };
}

test("selectors: a model with an optional effort, inherit, and inherit with an effort", () => {
  assert.deepEqual(parseCodexSelector("review", "gpt-5.5:high"), { model: "gpt-5.5", effort: "high" });
  assert.deepEqual(parseCodexSelector("review", "gpt-5.5"), { model: "gpt-5.5", effort: undefined });
  assert.deepEqual(parseCodexSelector("review", "inherit"), { model: null, effort: undefined });
  assert.deepEqual(parseCodexSelector("review", "inherit:xhigh"), { model: null, effort: "xhigh" });
  assert.deepEqual(parseCodexSelector("review", "custom/model:8b"), { model: "custom/model:8b", effort: undefined }, "an unknown suffix belongs to the model");
  assert.throws(() => parseCodexSelector("review", "bad model"), /Invalid selector for role "review"/);
});

test("the default file lists every role as inherit and parses with the shared schema", () => {
  const roles = parseModelsConfig(DEFAULT_MODELS, parseCodexSelector);
  assert.deepEqual(Object.keys(roles).sort(), ["backend", "default", "frontend", "implementation", "plan", "research", "review", "security"]);
  assert.ok(Object.values(roles).every(({ model, effort }) => model === null && effort === undefined));
});

test("an agent file gets model and model_reasoning_effort after its description and nothing for inherit", () => {
  const template = readFileSync(new URL("../codex/agents/reviewer.toml", import.meta.url), "utf8");
  const lines = renderCodexAgent(template, { model: "gpt-5.5", effort: "high" }).split("\n");

  assert.deepEqual(lines.slice(3, 5), ['model = "gpt-5.5"', 'model_reasoning_effort = "high"']);
  assert.equal(lines[5], "developer_instructions = '''");
  assert.equal(renderCodexAgent(template, { model: null, effort: undefined }), template);
  assert.deepEqual(renderCodexAgent(template, { model: null, effort: "low" }).split("\n").slice(3, 4), ['model_reasoning_effort = "low"']);
});

test("a fresh install creates models.yml with every role inheriting and leaves the agents without a model", async t => {
  const box = setup(t);

  const result = await box.install();

  assert.equal(readFileSync(box.modelsFile, "utf8"), DEFAULT_MODELS);
  assert.match(result.message, /Model roles: .*models\.yml \(created; every role inherits\)\./);
  for (const role of AGENT_ROLES) {
    assert.doesNotMatch(box.agent(role), /^model(_reasoning_effort)? =/m);
  }
});

test("the installer writes the configured model of each role, falling back to default", async t => {
  const box = setup(t);
  box.writeModels(["modelRoles:", "  default: gpt-5.4:low", "  review: gpt-5.5:high", "  security: inherit", "  plan: inherit:xhigh", ""].join("\n"));

  const result = await box.install();

  assert.match(box.agent("reviewer"), /^model = "gpt-5\.5"\nmodel_reasoning_effort = "high"$/m);
  assert.match(box.agent("backend"), /^model = "gpt-5\.4"\nmodel_reasoning_effort = "low"$/m, "a role without a row uses default");
  assert.doesNotMatch(box.agent("security-reviewer"), /^model/m, "inherit omits both lines");
  assert.match(box.agent("planner"), /^model_reasoning_effort = "xhigh"$/m);
  assert.doesNotMatch(box.agent("planner"), /^model = /m);
  assert.match(result.message, /us-reviewer: gpt-5\.5, effort high\./);
  assert.match(result.message, /us-planner: the Codex model, effort xhigh\./);
  assert.equal(readFileSync(box.modelsFile, "utf8").includes("gpt-5.5:high"), true, "an existing models file is never rewritten");

  const record = box.record();
  assert.equal(record.files["agents/us-reviewer.toml"], sha256(readFileSync(box.at("agents", "us-reviewer.toml"))));
});

test("an install over an install applies a changed models file to the agents", async t => {
  const box = setup(t);
  await box.install();
  box.writeModels("modelRoles:\n  review: gpt-5.5:medium\n");

  const result = await box.install();

  assert.match(box.agent("reviewer"), /^model = "gpt-5\.5"$/m);
  assert.match(result.message, /1 files written|files written/);
});

test("an invalid models file stops the install before anything is written", async t => {
  const box = setup(t);
  box.writeModels("modelRoles:\n  review: -bad\n");
  const before = listTree(box.codexHome);

  await assert.rejects(box.install(), /Refusing to install; nothing was changed:\n {2}.*models\.yml cannot be used \(Invalid selector for role "review"/);

  assert.deepEqual(listTree(box.codexHome), before);
});

test("a models file that is a symbolic link is refused", async t => {
  const box = setup(t);
  mkdirSync(path.dirname(box.modelsFile), { recursive: true });
  const elsewhere = path.join(box.root, "elsewhere.yml");
  writeFileSync(elsewhere, "modelRoles:\n");
  symlinkSync(elsewhere, box.modelsFile);

  await assert.rejects(box.install(), /models\.yml cannot be used \(.*is a symbolic link\)/);
  assert.equal(readCodexModels(box.codexHome).error.includes("symbolic link"), true);
});

test("apply rewrites the agents from an edited models file and keeps the install record truthful", async t => {
  const box = setup(t);
  await box.install();
  box.writeModels("modelRoles:\n  frontend: gpt-5.5:high\n  default: inherit\n");

  const applied = await box.apply();

  assert.equal(applied.created, false);
  assert.equal(applied.agents.frontend.state, "updated");
  assert.equal(applied.agents.backend.state, "ready");
  assert.match(box.agent("frontend"), /^model = "gpt-5\.5"\nmodel_reasoning_effort = "high"$/m);
  assert.equal(box.record().files["agents/us-frontend.toml"], sha256(readFileSync(box.at("agents", "us-frontend.toml"))));
  assert.match(formatApplied(applied), /us-frontend: gpt-5\.5, effort high \(updated\)\./);
  assert.match(formatApplied(applied), /Restart Codex/);
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /Files: \d+ ok, 0 modified/);

  const again = await box.apply();
  assert.ok(Object.values(again.agents).every(({ state }) => state === "ready"));
  assert.doesNotMatch(formatApplied(again), /Restart Codex/);

  box.writeModels("modelRoles:\n");
  const reset = await box.apply();
  assert.equal(reset.agents.frontend.state, "updated");
  assert.doesNotMatch(box.agent("frontend"), /^model/m);

  const reinstall = await box.install();
  assert.match(reinstall.message, /files already up to date/, "an install after apply sees no edited agent files");
});

test("apply leaves an agent file that was edited since the install, and updates the others", async t => {
  const box = setup(t);
  await box.install();
  writeFileSync(box.at("agents", "us-scout.toml"), `${box.agent("scout")}# my note\n`);
  box.writeModels("modelRoles:\n  default: gpt-5.5\n");

  const applied = await box.apply();

  assert.equal(applied.agents.scout.state, "conflict");
  assert.match(formatApplied(applied), /us-scout: left alone/);
  assert.match(box.agent("scout"), /# my note/);
  assert.doesNotMatch(box.agent("scout"), /^model = /m);
  assert.match(box.agent("reviewer"), /^model = "gpt-5\.5"$/m);
});

test("apply refuses when Useful Skills is not installed or the models file is invalid, and changes nothing", async t => {
  const box = setup(t);
  await assert.rejects(box.apply(), /not installed for Codex: no install record/);

  await box.install();
  box.writeModels("modelRoles:\n  review: not valid!\n");
  const before = box.agent("reviewer");

  await assert.rejects(box.apply(), /models\.yml cannot be used .*no agent was changed/);
  assert.equal(box.agent("reviewer"), before);
});

test("apply creates a missing models file and reports it", async t => {
  const box = setup(t);
  await box.install();
  const { unlinkSync } = await import("node:fs");
  unlinkSync(box.modelsFile);

  const applied = await box.apply();

  assert.equal(applied.created, true);
  assert.equal(readFileSync(box.modelsFile, "utf8"), DEFAULT_MODELS);
  assert.match(formatApplied(applied), /\(created with defaults\)/);
});

test("doctor lists the model roles and uninstall keeps the models file", async t => {
  const box = setup(t);
  box.writeModels("modelRoles:\n  review: gpt-5.5:high\n");
  await box.install();

  const report = inspectCodexInstall({ environment: box.environment }).text;
  assert.match(report, /Model roles: .*models\.yml\./);
  assert.match(report, /us-reviewer: gpt-5\.5, effort high\./);

  box.writeModels("modelRoles:\n  review: bad model\n");
  assert.match(inspectCodexInstall({ environment: box.environment }).text, /Model roles: .*cannot be used/);

  const { uninstallCodex } = await import("../codex/uninstall.js");
  const message = uninstallCodex({ environment: box.environment }).message;
  assert.match(message, /Kept the model roles file .*models\.yml\./);
  assert.ok(existsSync(box.modelsFile));
});

test("the installed runtime applies models on its own, and `models apply --host codex` does the same from a checkout", async t => {
  const box = createCodexSandbox();
  t.after(box.cleanup);
  // The real bundle, installed from this checkout as a local marketplace.
  await installCodex({ environment: box.environment, packageRoot: ROOT, local: true });
  const modelsFile = box.at("harness-useful-skills", "models.yml");
  writeFileSync(modelsFile, "modelRoles:\n  review: gpt-5.5:high\n");
  const script = box.at("harness-useful-skills", "runtime", "codex", "apply-models.js");
  const isolated = { HOME: path.join(box.root, "home"), CODEX_HOME: box.codexHome, PATH: process.env.PATH };

  const runtime = await exec(process.execPath, [script, "--json"], { env: isolated, cwd: box.root });
  const result = JSON.parse(runtime.stdout);
  assert.equal(result.agents.reviewer.state, "updated");
  assert.match(readFileSync(box.at("agents", "us-reviewer.toml"), "utf8"), /^model = "gpt-5\.5"$/m);
  assert.match(result.text, /us-reviewer: gpt-5\.5, effort high \(updated\)\./);

  writeFileSync(modelsFile, "modelRoles:\n  review: gpt-5.4\n");
  const launcher = await exec(process.execPath, [path.join(ROOT, "useful-skills"), "models", "apply", "--host", "codex"], { env: isolated, cwd: box.root });
  assert.match(launcher.stdout, /us-reviewer: gpt-5\.4 \(updated\)\./);

  const broken = await exec(process.execPath, [script, "--bogus"], { env: isolated, cwd: box.root }).catch(error => error);
  assert.equal(broken.code, 2);
});

test("`models apply` is Codex only", async () => {
  const refused = await exec(process.execPath, [path.join(ROOT, "useful-skills"), "models", "apply", "--host", "opencode"], { env: { PATH: process.env.PATH, HOME: "/nonexistent" } }).catch(error => error);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /models apply is for --host codex/);

  const wrong = await exec(process.execPath, [path.join(ROOT, "useful-skills"), "models", "--host", "codex"], { env: { PATH: process.env.PATH, HOME: "/nonexistent" } }).catch(error => error);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /Expected models apply --host codex/);
});
