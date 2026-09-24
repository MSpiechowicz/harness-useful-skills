import assert from "node:assert/strict";
import { chmod, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/extension-fixture.js";
import { STAGES, readWorkflowSettings } from "../workflow-settings.js";

test("profile guidance refreshes across sessions and instances, reconciling only owned instructions", async t => {
  const f = await fixture(t);
  let nativeCalls = 0;
  f.ctx.memory = { status: async () => { nativeCalls++; return {}; } };
  const hook = f.events.get("before_agent_start");
  const handler = f.commands.get("useful-skills").handler;
  const external = "preserve this independent instruction";
  const request = async (systemPrompt, prompt = "build a simulator") =>
    (await hook({ systemPrompt, prompt }, f.ctx))?.systemPrompt ?? systemPrompt;
  const defaults = await request(Object.freeze([external]));
  assert.equal(defaults[0], external);
  for (const stage of STAGES) {
    assert.ok(defaults.some(line => line.includes(`automatic ${stage} stage enabled`)));
  }
  assert.equal(await hook({ systemPrompt: defaults, prompt: "build a simulator" }, f.ctx), undefined);

  await handler("stage plan disabled", f.ctx);
  await handler("stage security-review disabled", f.ctx);
  await handler("stage backend-memory disabled", f.ctx);
  const selective = await request(defaults, "Document /skill:us-ignore-workflow for users.");
  assert.equal(selective[0], external);
  for (const stage of ["plan", "security-review", "backend-memory"]) {
    assert.ok(selective.some(line => line.includes(`automatic ${stage} stage disabled`)));
    assert.ok(!selective.some(line => line.includes(`automatic ${stage} stage enabled`)));
  }
  for (const stage of ["research", "review", "graphify-memory"]) {
    assert.ok(selective.some(line => line.includes(`automatic ${stage} stage enabled`)));
  }
  assert.ok(selective.some(line => line.includes("implementation without separate package-mandatory plan approval")));
  assert.ok(selective.some(line => line.includes("independent authorization requirements remain in force")));
  assert.equal(await hook({ systemPrompt: selective, prompt: "build a simulator" }, f.ctx), undefined);

  await handler("workflow disabled", f.ctx);
  const disabled = await request(selective, "Fix the bug. /skill:us-ignore-workflow");
  assert.equal(disabled[0], external);
  assert.ok(disabled.some(line => line.includes("fast lane is active")));
  assert.ok(!disabled.some(line => line.includes("automatic plan stage")));
  assert.ok(!disabled.some(line => line.includes("permit that required stage")));
  assert.equal(await hook({ systemPrompt: disabled, prompt: "build a simulator" }, f.ctx), undefined);
  f.switchSession("another-session");
  f.ctx.cwd = path.join(f.root, "different-workspace");
  assert.deepEqual(await request(selective), disabled, "profile setting, not session or workspace, selects guidance");

  const restarted = await fixture(t, true, undefined, f.agentDir);
  const otherHook = restarted.events.get("before_agent_start");
  const otherHandler = restarted.commands.get("useful-skills").handler;
  assert.deepEqual((await otherHook({ systemPrompt: selective, prompt: "fix a bug" }, restarted.ctx)).systemPrompt, disabled);
  await otherHandler("workflow enabled", restarted.ctx);
  assert.deepEqual(await request(disabled), selective, "another extension instance must refresh the same profile");
  await otherHandler("stage plan enabled", restarted.ctx);
  const restored = await request(selective);
  assert.ok(restored.some(line => line.includes("automatic plan stage enabled")));
  assert.ok(!restored.some(line => line.includes("automatic plan stage disabled")));
  assert.equal(nativeCalls, 0, "guidance does not perform automatic memory actions");
  assert.deepEqual(await readdir(f.root), []);
});

test("workflow and six independent stage commands persist exact modes, expose status, and reject invalid inputs", async t => {
  for (const hasUI of [true, false]) {
    await t.test(hasUI ? "interactive" : "headless", async t => {
      const f = await fixture(t, hasUI);
      const handler = f.commands.get("useful-skills").handler;
      await handler("workflow disabled", f.ctx);
      await handler("status", f.ctx);
      assert.match(f.messages.at(-1).message, /Research: saved enabled, effective disabled \(workflow disabled\)/);
      assert.ok(f.messages.at(-1).message.includes(path.join(f.agentDir, "useful-skills", "workflow-settings")));
      for (const stage of STAGES) {
        await handler(`stage ${stage} disabled`, f.ctx);
      }
      const before = await readWorkflowSettings({ agentDir: f.agentDir });
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
      const after = await readWorkflowSettings({ agentDir: f.agentDir });
      assert.deepEqual(after.values, before.values);
      await handler("status", f.ctx);
      const report = f.messages.at(-1).message;
      assert.match(report, /Workflow: saved disabled, effective disabled/);
      assert.match(report, /Security review: saved disabled, effective disabled/);
      assert.match(report, /Graphify memory: saved disabled, effective disabled/);
      await handler("workflow enabled", f.ctx);
      assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false, "master switch retains stage choices");
      if (!hasUI) {
        assert.ok(f.messages.every(message => message.options?.triggerTurn === false));
      }
    });
  }
});

test("corrupt regular settings fail closed until explicitly repaired; unsafe targets stay protected", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  const hook = f.events.get("before_agent_start");
  await handler("workflow disabled", f.ctx);
  const settingsDir = path.join(f.agentDir, "useful-skills", "workflow-settings");
  const external = "external higher-priority instruction";
  const disabled = (await hook({ systemPrompt: [external], prompt: "fix" }, f.ctx)).systemPrompt;
  await writeFile(path.join(settingsDir, "workflow.json"), "invalid JSON");
  const unknown = (await hook({ systemPrompt: disabled, prompt: "/skill:us-ignore-workflow" }, f.ctx)).systemPrompt;
  assert.equal(unknown[0], external);
  assert.ok(unknown.some(line => line.includes("could not safely determine the profile workflow mode")));
  assert.ok(!unknown.some(line => line.includes("fast lane is active") || line.includes("permit that required stage")));
  assert.equal(await hook({ systemPrompt: unknown, prompt: "fix" }, f.ctx), undefined);
  await handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown \(Workflow setting must contain a JSON boolean/);
  assert.match(f.messages.at(-1).message, /Research: saved enabled, effective unknown \(workflow setting unreadable\)/);
  assert.equal(f.messages.at(-1).level, "warning");
  await handler("workflow enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /workflow enabled for this OMP profile/);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.workflow, true);

  await writeFile(path.join(settingsDir, "review.json"), "invalid JSON");
  const selective = (await hook({ systemPrompt: unknown, prompt: "fix" }, f.ctx)).systemPrompt;
  assert.ok(selective.some(line => line.includes("automatic review stage could not be read safely")));
  assert.ok(selective.some(line => line.includes("automatic security-review stage enabled")));
  await handler("stage review disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /review disabled for this OMP profile/);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false);
  const sentinel = path.join(f.root, "sentinel.json");
  await writeFile(sentinel, "false");
  await rm(path.join(settingsDir, "review.json"));
  await symlink(sentinel, path.join(settingsDir, "review.json"));
  await handler("stage review enabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change review/);
  assert.equal(f.messages.at(-1).level, "error");
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, undefined);
  assert.equal(await readFile(sentinel, "utf8"), "false");
});

test("a missing agent profile never turns a read failure into enabled or disabled stage authority", async t => {
  const f = await fixture(t);
  await rm(f.agentDir, { recursive: true });
  const hook = f.events.get("before_agent_start");
  const guidance = (await hook({ systemPrompt: ["keep external guidance"], prompt: "fix" }, f.ctx)).systemPrompt;
  assert.equal(guidance[0], "keep external guidance");
  assert.ok(guidance.some(line => line.includes("could not safely determine the profile workflow mode")));
  assert.ok(!guidance.some(line => line.includes("fast lane is active") || line.includes("permit that required stage")));
  await f.commands.get("useful-skills").handler("status", f.ctx);
  assert.match(f.messages.at(-1).message, /Workflow: saved unknown, effective unknown \(/);
  await f.commands.get("useful-skills").handler("stage plan disabled", f.ctx);
  assert.match(f.messages.at(-1).message, /Cannot change plan/);
  assert.equal(f.messages.at(-1).level, "error");
});

test("a settings write failure is visible and leaves the profile choice unchanged", async t => {
  const f = await fixture(t);
  const handler = f.commands.get("useful-skills").handler;
  await chmod(f.agentDir, 0o500);
  try {
    await handler("stage review disabled", f.ctx);
    assert.match(f.messages.at(-1).message, /Cannot change review/);
    assert.equal(f.messages.at(-1).level, "error");
    const report = await readWorkflowSettings({ agentDir: f.agentDir });
    assert.equal(report.values.review, true);
  } finally {
    await chmod(f.agentDir, 0o700);
  }
});

test("headless help, status, stage menus, and cancellation behave without surprise writes or model turns", async t => {
  const f = await fixture(t, false);
  const handler = f.commands.get("useful-skills").handler;
  await handler("", f.ctx);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  assert.match(f.messages.at(-1).message, /\/useful-skills stage/);
  assert.match(f.messages.at(-1).message, /\/useful-skills status/);
  const initial = await readWorkflowSettings({ agentDir: f.agentDir });
  const interactive = { ...f.ctx, hasUI: true };
  const count = f.messages.length;
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  f.selectResponses.push("Update");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.ok(f.selections.at(-2).choices.includes("Stages"));
  assert.deepEqual(f.selections.at(-1), { title: "Update", choices: ["Check", "Install"] });
  f.selectResponses.push("Workflow (enabled)");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.deepEqual(f.selections.at(-1), { title: "Workflow: enabled", choices: ["Enabled", "Disabled"] });
  f.selectResponses.push("Stages");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.ok(f.selections.at(-1).choices.includes("Review (enabled)"));
  f.selectResponses.push("Stages", "Review (enabled)");
  await handler("", interactive);
  assert.equal(f.messages.length, count);
  assert.deepEqual(await readdir(f.agentDir), [], "cancelling menus must not create profile settings");
  assert.deepEqual(f.selections.at(-1), { title: "Review: enabled", choices: ["Enabled", "Disabled"] });
  assert.deepEqual((await readWorkflowSettings({ agentDir: f.agentDir })).values, initial.values);

  f.selectResponses.push("Stages", "Review (enabled)", "Disabled");
  await handler("", interactive);
  assert.equal((await readWorkflowSettings({ agentDir: f.agentDir })).values.review, false);
  f.selectResponses.push("Status");
  await handler("", interactive);
  assert.match(f.messages.at(-1).message, /Review: saved disabled, effective disabled/);
  f.selectResponses.push("Workflow (enabled)", "Disabled");
  await handler("", interactive);
  assert.ok((await f.events.get("before_agent_start")({ systemPrompt: [], prompt: "fix a bug" }, f.ctx)).systemPrompt.some(line => line.includes("fast lane is active")));
  f.selectResponses.push("Workflow (disabled)", "Enabled");
  await handler("", interactive);
  assert.ok((await f.events.get("before_agent_start")({ systemPrompt: [], prompt: "fix a bug" }, f.ctx)).systemPrompt.some(line => line.includes("automatic review stage disabled")));
});
