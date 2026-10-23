import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GENERATED_MARKER, isGeneratedAgent, parseModelsConfig, ROLE_AGENTS, syncRoleAgents } from "../model-roles.js";

// A provider-qualified selector syntax unlike Claude's, so the shared module is exercised host-neutrally.
function parseSelector(role, raw) {
  const match = /^([a-z]+)\/([a-z0-9.:-]+)$/.exec(raw);
  if (!match) {
    throw new Error(`Bad selector for ${role}.`);
  }
  return { provider: match[1], model: match[2] };
}

async function host(t, defaultConfig = "# roles\nmodelRoles:\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "harness-useful-skills", "models.yml");
  const agentDir = path.join(root, "agents");
  return {
    root,
    agentDir,
    options: {
      configFile,
      agentFile: agent => path.join(agentDir, `us-${agent}.md`),
      defaultConfig,
      parseSelector,
      render: (agent, selection) => `---\n${GENERATED_MARKER} test\nname: us-${agent}\nmodel: ${selection?.model ?? "inherit"}\n---\nbody\n`,
      fallback: undefined,
    },
  };
}

test("the config parser accepts the host's selector syntax and rejects unknown, repeated, or stray rows", () => {
  assert.deepEqual(parseModelsConfig("# c\nmodelRoles:\n  review: ollama/llama3:8b  # local\n  default: 'openai/gpt-5'\n", parseSelector), {
    review: { provider: "ollama", model: "llama3:8b" },
    default: { provider: "openai", model: "gpt-5" },
  });
  assert.deepEqual(parseModelsConfig("modelRoles:\n", parseSelector), {});

  assert.throws(() => parseModelsConfig("modelRoles:\n  review: nope\n", parseSelector), /Bad selector for review/);
  assert.throws(() => parseModelsConfig("modelRoles:\n  writer: a/b\n", parseSelector), /Unknown role "writer" on line 2/);
  assert.throws(() => parseModelsConfig("modelRoles:\n  plan: a/b\n  plan: a/c\n", parseSelector), /defined more than once/);
  assert.throws(() => parseModelsConfig("models:\n  plan: a/b\n", parseSelector), /Unsupported content on line 1/);
  assert.throws(() => parseModelsConfig("# empty\n", parseSelector), /Missing `modelRoles:`/);
});

test("first sync writes the default config privately and generates one agent per role agent", async t => {
  const { options, agentDir } = await host(t);
  const result = syncRoleAgents(options);

  assert.equal(result.created, true);
  assert.equal(await readFile(options.configFile, "utf8"), options.defaultConfig);
  assert.equal((await stat(path.dirname(options.configFile))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(agentDir)).sort(), Object.keys(ROLE_AGENTS).map(agent => `us-${agent}.md`).sort());
  assert.ok(Object.values(result.agents).every(agent => agent.state === "created" && agent.selection === undefined));

  const again = syncRoleAgents(options);
  assert.equal(again.created, false);
  assert.ok(Object.values(again.agents).every(agent => agent.state === "ready"));
});

test("a role selection wins over default, and only changed agents are rewritten", async t => {
  const { options } = await host(t);
  syncRoleAgents(options);
  await writeFile(options.configFile, "modelRoles:\n  review: openai/gpt-5\n  default: ollama/qwen3\n");

  const result = syncRoleAgents(options);
  assert.deepEqual(result.agents.reviewer.selection, { provider: "openai", model: "gpt-5" });
  assert.deepEqual(result.agents.planner.selection, { provider: "ollama", model: "qwen3" });
  assert.equal(result.agents.reviewer.state, "updated");
  assert.match(await readFile(options.agentFile("reviewer"), "utf8"), /^model: gpt-5$/m);
});

test("a user-owned agent file is reported as a conflict and left untouched", async t => {
  const { options } = await host(t);
  syncRoleAgents(options);
  await writeFile(options.agentFile("scout"), "my own scout\n");

  const result = syncRoleAgents(options);
  assert.equal(result.agents.scout.state, "conflict");
  assert.equal(await readFile(options.agentFile("scout"), "utf8"), "my own scout\n");
});

test("a user agent that only mentions the marker in its body is a conflict, not a generated agent", async t => {
  const { options } = await host(t);
  syncRoleAgents(options);
  const own = `---\nname: us-planner\nmodel: mine\n---\nNotes copied from a generated file:\n${GENERATED_MARKER} from models.yml\n`;
  await writeFile(options.agentFile("planner"), own);

  const result = syncRoleAgents(options);
  assert.equal(result.agents.planner.state, "conflict");
  assert.equal(await readFile(options.agentFile("planner"), "utf8"), own);
  assert.equal(result.agents.scout.state, "ready", "agents generated with the marker after the opening --- stay ours");
});

test("isGeneratedAgent requires the marker on the line right after the opening ---", () => {
  assert.equal(isGeneratedAgent(`---\n${GENERATED_MARKER} from models.yml (role: plan).\nname: us-planner\n---\nbody\n`), true);
  assert.equal(isGeneratedAgent(`---\r\n${GENERATED_MARKER} from models.yml\r\n---\r\n`), true);
  assert.equal(isGeneratedAgent(`---\nname: us-planner\n${GENERATED_MARKER} from models.yml\n---\n`), false);
  assert.equal(isGeneratedAgent(`${GENERATED_MARKER} from models.yml\n`), false);
  assert.equal(isGeneratedAgent(`text\n---\n${GENERATED_MARKER} from models.yml\n`), false);
  assert.equal(isGeneratedAgent(`---\n${GENERATED_MARKER}X\n`), false);
});

test("an invalid or oversized config reports an error and generates nothing", async t => {
  const { options, agentDir } = await host(t, "modelRoles:\n  plan: broken\n");
  const invalid = syncRoleAgents(options);
  assert.equal(invalid.created, true);
  assert.match(invalid.error, /Bad selector for plan/);
  assert.deepEqual(invalid.agents, {});
  await assert.rejects(readdir(agentDir), { code: "ENOENT" });

  await writeFile(options.configFile, `modelRoles:\n${"# padding\n".repeat(2000)}`);
  assert.match(syncRoleAgents(options).error, /exceeds 16 KiB/);
});
