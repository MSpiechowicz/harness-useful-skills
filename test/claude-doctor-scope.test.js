import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runClaudeDoctor } from "../claude/doctor-setup.js";
import { resolveHostContext } from "../claude/host-context.js";
import { extract, mountLine, validGraph } from "./helpers/graph-fixture.js";
import { fixture, gitHome, graphOutcome, HOME_BLOCKED } from "./helpers/claude-doctor-fixture.js";

test("a project outside Git is set up without installing dependencies or building a graph", async t => {
  const f = await fixture(t);
  const plain = path.join(f.root, "plain");
  await mkdir(plain);

  const setup = await f.run(["doctor"], { project: plain });
  assert.equal(setup.exitCode, 0, setup.text);
  assert.match(setup.text, /\n {2}Dependencies: skipped — not a Git repository\n {2}Graph: skipped — not a Git repository\n/);
  assert.deepEqual(f.calls, { install: 0, build: 0 });

  const check = await f.run(["doctor", "--check"], { project: plain });
  assert.equal(check.exitCode, 0, check.text);
  assert.match(check.text, /\n {2}Dependencies: missing — not a Git repository\n {2}Graph: not built — not a Git repository\n/);
  assert.deepEqual(f.calls, { install: 0, build: 0 });
});

test("a project root at the home directory is never scanned and installs no dependencies", async t => {
  const f = await fixture(t);
  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });

  const outcome = await runClaudeDoctor({ ...host, services: f.services, home: f.repo });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.steps.slice(1), [
    { label: "Dependencies", outcome: "skipped", detail: HOME_BLOCKED },
    { label: "Graph", outcome: "skipped", detail: HOME_BLOCKED },
  ]);
  assert.deepEqual(f.calls, { install: 0, build: 0 });

  const check = await runClaudeDoctor({ ...host, check: true, services: f.services, home: f.repo });
  assert.equal(check.ok, true);
  assert.deepEqual(check.steps.slice(1), [
    { label: "Dependencies", outcome: "missing", detail: HOME_BLOCKED },
    { label: "Graph", outcome: "not built", detail: HOME_BLOCKED },
  ]);

  const partial = await fixture(t, { dependencyState: "partial" });
  const partialHost = await resolveHostContext({ workspace: partial.repo, data: partial.dataDir });
  const incomplete = await runClaudeDoctor({ ...partialHost, check: true, services: partial.services, home: partial.repo });
  assert.deepEqual(incomplete.steps[1], { label: "Dependencies", outcome: "incomplete", detail: HOME_BLOCKED });
  assert.equal(partial.calls.install, 0);
});

test("an existing graph still gets missing dependencies installed even when the scope now blocks a build", async t => {
  const f = await fixture(t);
  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const built = await runClaudeDoctor({ ...host, services: f.services });
  assert.equal(built.ok, true);
  assert.deepEqual(f.calls, { install: 1, build: 1 });

  const services = { ...f.services, dependencyStatus: async () => ({ ready: false, state: "missing" }) };
  const outcome = await runClaudeDoctor({ ...host, services, home: f.repo });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.steps.slice(1), [
    { label: "Dependencies", outcome: "installed" },
    { label: "Graph", outcome: "existing (1 nodes, 0 edges)" },
  ]);
  assert.deepEqual(f.calls, { install: 2, build: 1 });
});

test("an unreadable graph status installs no dependencies when the scope blocks a build", async t => {
  const f = await fixture(t);
  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const graphify = { ...f.services.graphify, graphStatus: async () => ({ available: false, error: "Graph snapshot is unreadable." }) };
  const services = { ...f.services, graphify };

  const outcome = await runClaudeDoctor({ ...host, services, home: f.repo });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.steps.slice(1), [
    { label: "Dependencies", outcome: "skipped", detail: HOME_BLOCKED },
    { label: "Graph", outcome: "error", detail: "Graph snapshot is unreadable." },
  ]);
  assert.deepEqual(f.calls, { install: 0, build: 0 });

  const allowed = await runClaudeDoctor({ ...host, services });
  assert.deepEqual(allowed.steps[1], { label: "Dependencies", outcome: "installed" });
  assert.equal(f.calls.install, 1);
});

test("a Git work tree that is or contains the home directory is never scanned", async t => {
  const f = await fixture(t);

  // A dotfiles checkout: the home directory itself is a Git work tree.
  const dotfilesHome = path.join(f.root, "dotfiles-home");
  const config = path.join(dotfilesHome, ".config");
  await mkdir(path.join(dotfilesHome, ".git"), { recursive: true });
  await mkdir(config);

  // A Git work tree containing the home directory, opened at the home directory's parent.
  const outer = path.join(f.root, "outer");
  const users = path.join(outer, "users");
  const nestedHome = path.join(users, "home");
  await mkdir(path.join(outer, ".git"), { recursive: true });
  await mkdir(nestedHome, { recursive: true });

  for (const [workspace, home] of [[config, dotfilesHome], [users, nestedHome], [outer, nestedHome]]) {
    const host = await resolveHostContext({ workspace, data: f.dataDir });
    const outcome = await runClaudeDoctor({ ...host, services: f.services, home });
    assert.deepEqual(outcome.steps.at(-1), { label: "Graph", outcome: "skipped", detail: HOME_BLOCKED }, workspace);
    assert.equal(outcome.ok, true);
  }
  assert.deepEqual(f.calls, { install: 0, build: 0 });

  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const normal = await runClaudeDoctor({ ...host, services: f.services, home: f.root });
  assert.equal(normal.ok, true);
  assert.deepEqual(normal.steps.slice(1), [
    { label: "Dependencies", outcome: "installed" },
    { label: "Graph", outcome: "built (1 nodes, 0 edges)" },
  ]);
  assert.deepEqual(f.calls, { install: 1, build: 1 });
});

test("an empty, relative, or missing $HOME never lets the account's real home be scanned", async t => {
  const f = await fixture(t);
  const home = await gitHome(f);
  const account = () => ({ homedir: home });

  const unknown = [
    { homedir: () => "", userInfo: account },
    { homedir: () => "relative/home", userInfo: account },
    { homedir: () => { throw new Error("no home"); }, userInfo: account },
  ];
  for (const system of unknown) {
    assert.deepEqual(await graphOutcome(f, home, system), { label: "Graph", outcome: "skipped", detail: "home directory cannot be determined safely" });
  }

  const missing = { homedir: () => path.join(f.root, "absent-home"), userInfo: account };
  assert.deepEqual(await graphOutcome(f, home, missing), { label: "Graph", outcome: "skipped", detail: HOME_BLOCKED });
  assert.equal(f.calls.build, 0);
});

test("the account home stays protected when $HOME points elsewhere", async t => {
  const f = await fixture(t);
  const home = await gitHome(f);
  const config = path.join(home, ".config");
  await mkdir(config);

  const system = { homedir: () => f.repo, userInfo: () => ({ homedir: home }) };
  assert.deepEqual(await graphOutcome(f, config, system), { label: "Graph", outcome: "skipped", detail: HOME_BLOCKED });
  assert.equal(f.calls.build, 0);
});

test("a project that is a home directory or the filesystem root under another mount is never scanned", async t => {
  const f = await fixture(t);
  const home = path.join(f.root, "home");
  await mkdir(home);
  const homes = { homedir: () => home, userInfo: () => ({ homedir: home }) };

  // Simulate bind mounts: the project directory reports the identity of the home directory, its parent, or `/`.
  for (const target of [home, f.root, "/"]) {
    const mounted = (file, options) => stat(file === f.repo ? target : file, options);
    assert.deepEqual(await graphOutcome(f, f.repo, { ...homes, stat: mounted }), { label: "Graph", outcome: "skipped", detail: HOME_BLOCKED }, target);
  }

  const unreadable = async (file, options) => {
    if (file === f.repo) {
      throw new Error("EACCES");
    }

    return stat(file, options);
  };
  assert.deepEqual(await graphOutcome(f, f.repo, { ...homes, stat: unreadable }), { label: "Graph", outcome: "skipped", detail: "project directory identity cannot be checked" });
  assert.equal(f.calls.build, 0);
});

test("a normal repository inside the home directory is still built", async t => {
  const f = await fixture(t);
  const system = { homedir: () => f.root, userInfo: () => { throw new Error("no passwd entry"); } };

  assert.deepEqual(await graphOutcome(f, f.repo, system), { label: "Graph", outcome: "built (1 nodes, 0 edges)" });
  assert.equal(f.calls.build, 1);
});

test("a project containing a nested mount is never scanned, and the build re-checks doctor's scope", async t => {
  const f = await fixture(t);
  const host = await resolveHostContext({ workspace: f.repo, data: f.dataDir });
  const nested = mountLine(path.join(f.repo, "data"));
  const detail = `workspace contains a nested mount at ${path.join(f.repo, "data")}`;
  const mounted = { readMountInfo: async () => nested };

  const setup = await runClaudeDoctor({ ...host, services: f.services, system: mounted });
  assert.equal(setup.ok, true);
  assert.deepEqual(setup.steps.slice(1), [
    { label: "Dependencies", outcome: "skipped", detail },
    { label: "Graph", outcome: "skipped", detail },
  ]);
  const check = await runClaudeDoctor({ ...host, check: true, services: f.services, system: mounted });
  assert.deepEqual(check.steps.at(-1), { label: "Graph", outcome: "not built", detail });
  assert.deepEqual(f.calls, { install: 0, build: 0 });

  // A mount that appears after doctor's own check is still refused by the default build service.
  let reads = 0;
  const late = { readMountInfo: async () => (reads++ === 0 ? mountLine("/") : nested) };
  const { graphify: _graphify, ...dependencies } = f.services;
  const runProcess = async (_file, args) => {
    f.calls.build++;
    return extract(args, validGraph);
  };
  const raced = await runClaudeDoctor({ ...host, services: { ...dependencies, runProcess }, system: late });
  assert.deepEqual(raced.steps.at(-1), { label: "Graph", outcome: "failed", detail: `Graphify build refused: ${detail}.` });
  assert.equal(f.calls.build, 0);
});
