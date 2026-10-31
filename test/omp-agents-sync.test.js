import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GENERATED_MARKER, isGeneratedAgent } from "../model-roles.js";
import { removeOmpAgents, syncOmpAgents } from "../omp/agents-sync.js";

const BUNDLED = ["backend", "frontend", "planner", "release-assessor"];

async function host(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "us-omp-agents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  return { root, agentDir, agents: path.join(agentDir, "agents") };
}

function states(result) {
  return Object.fromEntries(Object.entries(result.agents).map(([name, agent]) => [name, agent.state]));
}

async function sourceDir(root, files) {
  const directory = path.join(root, "source");
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

test("sync writes the bundled agents as marked files whose frontmatter still parses", async t => {
  const h = await host(t);
  const result = await syncOmpAgents({ agentDir: h.agentDir });

  assert.equal(result.directory, h.agents);
  assert.deepEqual(states(result), { backend: "created", frontend: "created", planner: "created", "release-assessor": "created" });
  assert.deepEqual((await readdir(h.agents)).sort(), BUNDLED.map(name => `${name}.md`));

  for (const name of BUNDLED) {
    const text = await readFile(path.join(h.agents, `${name}.md`), "utf8");
    assert.equal(isGeneratedAgent(text), true, name);
    assert.match(text, new RegExp(`^---\\n${GENERATED_MARKER} for Oh My Pi; edits are replaced on update\\.\\nname: ${name}\\n`), name);
    assert.match(text, /\n---\n/, "frontmatter stays closed");
    assert.equal(result.agents[name].file, path.join(h.agents, `${name}.md`));
  }
});

test("a second sync is ready, and a changed bundled agent is updated in place", async t => {
  const h = await host(t);
  const source = await sourceDir(h.root, { "scout.md": "---\nname: scout\n---\nbody one\n" });

  await syncOmpAgents({ agentDir: h.agentDir, sourceDir: source });
  assert.deepEqual(states(await syncOmpAgents({ agentDir: h.agentDir, sourceDir: source })), { scout: "ready" });

  await writeFile(path.join(source, "scout.md"), "---\nname: scout\n---\nbody two\n");
  assert.deepEqual(states(await syncOmpAgents({ agentDir: h.agentDir, sourceDir: source })), { scout: "updated" });
  assert.match(await readFile(path.join(h.agents, "scout.md"), "utf8"), /body two/);
});

test("a user-owned agent with a bundled name is a conflict and stays byte for byte", async t => {
  const h = await host(t);
  const mine = "---\nname: planner\n---\nmy own planner\n";
  await mkdir(h.agents, { recursive: true });
  await writeFile(path.join(h.agents, "planner.md"), mine);
  // The marker anywhere but the line after the opening fence does not make a file ours.
  await writeFile(path.join(h.agents, "frontend.md"), `---\nname: frontend\n---\n${GENERATED_MARKER} for Oh My Pi; edits are replaced on update.\n`);

  const result = await syncOmpAgents({ agentDir: h.agentDir });

  assert.deepEqual(states(result), { backend: "created", frontend: "conflict", planner: "conflict", "release-assessor": "created" });
  assert.equal(await readFile(path.join(h.agents, "planner.md"), "utf8"), mine);
  assert.match(await readFile(path.join(h.agents, "frontend.md"), "utf8"), /^---\nname: frontend/);
});

test("a link where an agent belongs is a conflict and its target is untouched", async t => {
  const h = await host(t);
  const elsewhere = path.join(h.root, "elsewhere.md");
  await writeFile(elsewhere, "keep");
  await mkdir(h.agents, { recursive: true });
  await symlink(elsewhere, path.join(h.agents, "planner.md"));

  const result = await syncOmpAgents({ agentDir: h.agentDir });

  assert.equal(result.agents.planner.state, "conflict");
  assert.equal(await readFile(elsewhere, "utf8"), "keep");
});

test("an unusable bundled agent is reported as an error without stopping the others", async t => {
  const h = await host(t);
  const source = await sourceDir(h.root, { "broken.md": "no frontmatter\n", "good.md": "---\nname: good\n---\n" });

  const result = await syncOmpAgents({ agentDir: h.agentDir, sourceDir: source });

  assert.equal(result.agents.broken.state, "error");
  assert.match(result.agents.broken.message, /frontmatter/);
  assert.equal(result.agents.good.state, "created");
});

test("sync removes generated agents that are no longer bundled and keeps the user's own", async t => {
  const h = await host(t);
  const source = await sourceDir(h.root, { "scout.md": "---\nname: scout\n---\n" });
  await syncOmpAgents({ agentDir: h.agentDir });
  await writeFile(path.join(h.agents, "mine.md"), "---\nname: mine\n---\n");
  await writeFile(path.join(h.agents, "notes.txt"), "not an agent");

  const result = await syncOmpAgents({ agentDir: h.agentDir, sourceDir: source });

  assert.deepEqual(states(result), { backend: "removed", frontend: "removed", planner: "removed", "release-assessor": "removed", scout: "created" });
  assert.deepEqual((await readdir(h.agents)).sort(), ["mine.md", "notes.txt", "scout.md"]);
});

test("removeOmpAgents deletes only generated agents and reports them", async t => {
  const h = await host(t);
  await syncOmpAgents({ agentDir: h.agentDir });
  await writeFile(path.join(h.agents, "mine.md"), "---\nname: mine\n---\n");

  const removed = removeOmpAgents({ agentDir: h.agentDir });

  assert.deepEqual(removed.sort(), BUNDLED.map(name => path.join(h.agents, `${name}.md`)));
  assert.deepEqual(await readdir(h.agents), ["mine.md"]);
  assert.deepEqual(removeOmpAgents({ agentDir: h.agentDir }), []);
  assert.deepEqual(removeOmpAgents({ agentDir: path.join(h.root, "missing") }), []);
});

test("sync and uninstall leave agents other Useful Skills generators wrote", async t => {
  const { agentDir, agents } = await host(t);
  await mkdir(agents, { recursive: true });
  const claude = `---\n${GENERATED_MARKER} from /x/models.yml (role: plan); edits are replaced.\nname: us-planner\n---\n`;
  await writeFile(path.join(agents, "us-planner.md"), claude);

  syncOmpAgents({ agentDir });
  removeOmpAgents({ agentDir });

  assert.equal(await readFile(path.join(agents, "us-planner.md"), "utf8"), claude);
});
