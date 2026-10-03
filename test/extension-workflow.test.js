import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LEFT, fixture } from "./helpers/extension-fixture.js";
import { STAGES, readWorkflowSettings } from "../workflow-settings.js";
import { git } from "./helpers/git-fixture.js";

const settings = f => readWorkflowSettings({ agentDir: f.agentDir, cwd: f.ctx.cwd });
const request = async (f, systemPrompt, prompt = "build a simulator") =>
  (await f.events.get("before_agent_start")({ systemPrompt, prompt }, f.ctx))?.systemPrompt ?? systemPrompt;

test("repository guidance refreshes across sessions, cwd changes and instances, preserving external instructions", async t => {
  const f = await fixture(t);
  await git(f.root, "init", "--quiet");
  let nativeCalls = 0;
  f.ctx.memory = { status: async () => { nativeCalls++; return {}; } };
  const handler = f.commands.get("useful-skills").handler;
  const external = "preserve this independent instruction";
  const defaults = await request(f, Object.freeze([external]));
  assert.equal(defaults[0], external);
  assert.equal(defaults.length, 3 + STAGES.length);
  assert.equal(await f.events.get("before_agent_start")({ systemPrompt: defaults }, f.ctx), undefined);

  for (const stage of ["plan", "security-review", "backend-memory"]) {
    await handler(`stage ${stage} disabled`, f.ctx);
  }
  const selective = await request(f, defaults, "Document /skill:us-ignore-workflow for users.");
  assert.equal(selective[0], external);
  assert.equal(selective.length, defaults.length);
  assert.equal(selective.filter((line, index) => line !== defaults[index]).length, 3);
  assert.deepEqual(await request(f, selective, "fix an import"), selective, "prompt text does not classify the lane");

  await handler("workflow disabled", f.ctx);
  const disabled = await request(f, selective);
  assert.equal(disabled[0], external);
  assert.equal(disabled.length, 2);
  f.switchSession("another-session");
  assert.deepEqual(await request(f, selective), disabled);

  const restarted = await fixture(t, true, undefined, f.agentDir);
  restarted.ctx.cwd = f.root;
  assert.deepEqual(await request(restarted, selective), disabled);
  const otherHandler = restarted.commands.get("useful-skills").handler;
  await otherHandler("workflow enabled", restarted.ctx);
  assert.deepEqual(await request(f, disabled), selective, "same checkout refreshes another instance's write");
  await otherHandler("workflow disabled", restarted.ctx);

  const otherWorkspace = path.join(path.dirname(f.root), "different-workspace");
  await mkdir(otherWorkspace);
  await git(otherWorkspace, "init", "--quiet");
  f.ctx.cwd = otherWorkspace;
  assert.deepEqual(await request(f, disabled), selective, "new workspace has default master and shared stage choices");
  assert.equal((await settings(f)).values.workflow, true);
  assert.equal((await settings(restarted)).values.workflow, false);
  await handler("stage plan enabled", f.ctx);
  restarted.ctx.cwd = otherWorkspace;
  assert.deepEqual(await request(f, selective), await request(restarted, selective));
  assert.equal((await settings(restarted)).values.plan, true);
  assert.equal(nativeCalls, 0, "guidance never performs memory actions");
  assert.deepEqual(await readdir(f.root), [".git"]);
  assert.deepEqual(await readdir(otherWorkspace), [".git"]);
});

test("commands persist exact modes, expose both scopes and paths, and reject invalid inputs", async t => {
  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      const f = await fixture(t, hasUI);
      const handler = f.commands.get("useful-skills").handler;
      await handler("workflow disabled", f.ctx);
      assert.ok(f.messages.at(-1).message.includes(f.root));
      await handler("status", f.ctx);
      assert.match(f.messages.at(-1).message, /Research: saved enabled, effective disabled \(workflow disabled\)/);
      const snapshot = await settings(f);
      for (const value of [snapshot.scopeRoot, snapshot.workflowFile, snapshot.directory]) {
        assert.ok(f.messages.at(-1).message.includes(value));
      }
      for (const stage of STAGES) {
        await handler(`stage ${stage} disabled`, f.ctx);
        assert.match(f.messages.at(-1).message, /this OMP profile/);
      }
      const before = await settings(f);
      for (const key of ["workflow", ...STAGES]) {
        assert.equal(before.values[key], false);
      }
      for (const input of [
        "workflow", "workflow enabled extra", "workflow off", "workflow Disabled",
        "stage", "stage research", "stage research Disabled", "stage unlisted enabled", "stage review enabled extra",
      ]) {
        await handler(input, f.ctx);
        assert.match(f.messages.at(-1).message, /Expected \/useful-skills/);
        if (hasUI) {
          assert.equal(f.messages.at(-1).level, "warning");
        } else {
          assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
        }
      }
      assert.deepEqual((await settings(f)).values, before.values);
      await handler("status", f.ctx);
      const report = f.messages.at(-1).message;
      assert.match(report, /Workflow: saved disabled, effective disabled/);
      assert.match(report, /Security review: saved disabled, effective disabled/);
      assert.match(report, /Graphify memory: saved disabled, effective disabled/);
      await handler("workflow enabled", f.ctx);
      assert.equal((await settings(f)).values.review, false, "master switch retains stage choices");
      if (!hasUI) {
        assert.ok(f.messages.every(message => message.options?.triggerTurn === false));
      }
    });
  }
});

test("corrupt settings fail closed until explicitly repaired; unsafe targets stay protected", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await handler("workflow disabled", f.ctx);
  const snapshot = await settings(f);
  const external = "external higher-priority instruction";
  const disabled = await request(f, [external]);
  await writeFile(snapshot.workflowFile, "invalid JSON");
  const unknown = await request(f, disabled, "/skill:us-ignore-workflow");
  assert.equal(unknown[0], external);
  assert.equal(unknown.length, 2);
  assert.notDeepEqual(unknown, disabled);
  assert.deepEqual(await request(f, unknown), unknown);
  await handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown \(Workflow setting must contain a JSON boolean/);
  assert.match(f.messages.at(-1).message, /Research: saved enabled, effective unknown \(workflow setting unreadable\)/);
  assert.equal(f.messages.at(-1).level, "warning");
  await handler("workflow enabled", f.ctx);
  assert.ok(f.messages.at(-1).message.includes(f.root));
  assert.equal((await settings(f)).values.workflow, true);

  const enabled = await request(f, unknown);
  await writeFile(path.join(snapshot.directory, "review.json"), "invalid JSON", { mode: 0o600 });
  const selective = await request(f, enabled);
  assert.equal(selective.filter((line, index) => line !== enabled[index]).length, 1);
  await handler("stage review disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /review disabled for this OMP profile/);
  assert.equal((await settings(f)).values.review, false);
  const sentinel = path.join(f.root, "sentinel.json");
  await writeFile(sentinel, "false");
  await rm(path.join(snapshot.directory, "review.json"));
  await symlink(sentinel, path.join(snapshot.directory, "review.json"));
  await handler("stage review enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change review/);
  assert.equal(f.messages.at(-1).level, "error");
  assert.equal((await settings(f)).values.review, undefined);
  assert.equal(await readFile(sentinel, "utf8"), "false");
});

test("missing profile cannot authorize stages, while invalid cwd still allows independent stage changes", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  const enabled = await request(f, ["keep external guidance"]);
  const root = f.ctx.cwd;
  f.ctx.cwd = path.join(root, "missing");
  const unknown = await request(f, enabled);
  assert.equal(unknown[0], enabled[0]);
  assert.equal(unknown.length, 2);
  await handler("stage plan disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /plan disabled for this OMP profile/);
  assert.equal((await settings(f)).values.plan, false);
  await handler("workflow enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change workflow/);
  await handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown/);
  assert.match(f.messages.at(-1).message, /Plan: saved disabled, effective disabled/);
  f.ctx.cwd = root;
  await rm(f.agentDir, { recursive: true });
  assert.deepEqual(await request(f, enabled), unknown);
  await handler("stage plan disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change plan/);
  assert.equal(f.messages.at(-1).level, "error");
});

test("settings write failure is visible and leaves the saved stage choice unchanged", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await chmod(f.agentDir, 0o500);
  try {
    await handler("stage review disabled", f.ctx);
    assert.match(f.messages.at(-1).message, /Cannot change review/);
    assert.equal(f.messages.at(-1).level, "error");
    assert.equal((await settings(f)).values.review, true);
  } finally {
    await chmod(f.agentDir, 0o700);
  }
});

test("help, menus and cancellation produce no surprise writes or model turns", async t => {
  const f = await fixture(t, false);
  const handler = f.commands.get("useful-skills").handler;
  await handler("", f.ctx);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  assert.match(f.messages.at(-1).message, /\/useful-skills stage/);
  assert.match(f.messages.at(-1).message, /\/useful-skills status/);
  const interactive = { ...f.ctx, hasUI: true };
  const count = f.messages.length;
  for (const responses of [[], ["Update"], ["Repository Workflow (enabled)"],
    ["Profile Workflow Stages"], ["Profile Workflow Stages", "Review (enabled)"]]) {
    f.selectResponses.push(...responses);
    await handler("", interactive);
    assert.equal(f.messages.length, count);
    assert.deepEqual(await readdir(f.agentDir), []);
  }
  assert.ok(f.selections.at(-1).choices.includes("Disabled"));
  f.selectResponses.push("Profile Workflow Stages", "Review (enabled)", "Disabled");
  await handler("", interactive);
  assert.equal((await settings(f)).values.review, false);
  f.selectResponses.push("Status");
  await handler("", interactive);
  assert.match(f.messages.at(-1).message, /Review: saved disabled, effective disabled/);
  f.selectResponses.push("Repository Workflow (enabled)", "Disabled");
  await handler("", interactive);
  assert.equal((await settings(f)).values.workflow, false);
  f.selectResponses.push("Repository Workflow (disabled)", "Enabled");
  await handler("", interactive);
  assert.equal((await settings(f)).values.workflow, true);
  assert.equal((await settings(f)).values.review, false);
});

test("Left returns through parent menus without writing until a mode is selected", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  f.selectResponses.push("Repository Workflow (enabled)", LEFT, "Update", LEFT,
    "Profile Workflow Stages", "Review (enabled)", LEFT, LEFT, "Status");
  await handler("", f.ctx);
  assert.deepEqual(f.selectResponses, []);
  assert.match(f.messages.at(-1).message, /Workflow: saved enabled, effective enabled/);
  assert.match(f.messages.at(-1).message, /Review: saved enabled, effective enabled/);
  assert.deepEqual(await readdir(f.agentDir), []);
  f.selectResponses.push("Profile Workflow Stages", "Review (enabled)", LEFT, "Plan (enabled)", "Disabled");
  await handler("", f.ctx);
  assert.deepEqual(f.selectResponses, []);
  assert.deepEqual(await readdir(path.join(f.agentDir, "useful-skills", "workflow-settings")), ["plan.json"]);
  const snapshot = await settings(f);
  assert.equal(snapshot.values.plan, false);
  assert.equal(snapshot.values.review, true);
  assert.equal(snapshot.values.workflow, true);
  assert.equal(f.messages.length, 2, "Back does not dispatch an action");
});

test("Escape closes the whole workbench, including after Left, without creating settings", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  for (const responses of [[], ["Repository Workflow (enabled)"], ["Profile Workflow Stages"],
    ["Profile Workflow Stages", "Plan (enabled)"], ["Update"],
    ["Profile Workflow Stages", "Plan (enabled)", LEFT], ["Update", LEFT]]) {
    f.selectResponses.push(...responses);
    await handler("", f.ctx);
    assert.equal(f.selectResponses.length, 0);
    assert.deepEqual(await readdir(f.agentDir), []);
    assert.equal(f.messages.length, 0);
  }
});
