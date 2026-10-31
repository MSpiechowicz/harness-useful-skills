import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_MARKER, AGENT_ROLES, parseAgentToml, readAgents } from "../codex/agents.js";

const AGENTS = fileURLToPath(new URL("../codex/agents/", import.meta.url));
const READ_ONLY = ["planner", "scout", "reviewer", "security-reviewer", "release-assessor"];

test("there are exactly the eight role files", async () => {
  assert.equal(AGENT_ROLES.length, 8);
  assert.deepEqual((await readdir(AGENTS)).sort(), AGENT_ROLES.map(role => `${role}.toml`).sort());
});

test("each file starts with the marker, carries only the three keys, and names us-<stem>", async () => {
  for (const { role, text, agent } of await readAgents(AGENTS)) {
    assert.equal(text.split("\n")[0], AGENT_MARKER, role);
    assert.deepEqual(Object.keys(agent), ["name", "description", "developer_instructions"], role);
    assert.equal(agent.name, `us-${role}`);
    assert.ok(agent.description.length > 20 && agent.description.length < 300, role);
    assert.ok(agent.developer_instructions.endsWith("\n"), role);
    // Top-level keys in the file, found independently of the parser.
    const keys = text.split("\n").filter(line => /^[A-Za-z_]+ = /.test(line)).map(line => line.split(" = ")[0]);
    assert.deepEqual(keys, ["name", "description", "developer_instructions"], role);
    assert.ok(!/^\s*(model|model_reasoning_effort|sandbox_mode)\b/m.test(text), role);
    assert.equal((text.match(/'''/g) ?? []).length, 2, role);
  }
});

test("read-only roles say so and name the limit of the enforcement", async () => {
  for (const { role, agent } of await readAgents(AGENTS)) {
    const text = agent.developer_instructions;
    if (READ_ONLY.includes(role)) {
      assert.match(text, /read-only/i, role);
      assert.match(text, /do not edit/i, role);
      assert.match(text, /nothing but these instructions/, role);
    } else {
      assert.match(text, /assigned ownership|authorized/, role);
    }
  }
});

test("role text names Codex skills and agents, not other hosts", async () => {
  for (const file of AGENT_ROLES.map(role => `${role}.toml`)) {
    const text = await readFile(path.join(AGENTS, file), "utf8");
    assert.doesNotMatch(text, /Claude|OpenCode|\bOMP\b|useful-skills:|\/skill:|subagent_type|\bbash\b|grep, glob/i, file);
  }
});

test("the parser rejects text outside the restricted shape", () => {
  const good = `${AGENT_MARKER}\nname = "us-x"\ndescription = "d"\ndeveloper_instructions = '''\nbody\n'''\n`;
  assert.deepEqual(parseAgentToml(good), { name: "us-x", description: "d", developer_instructions: "body\n" });
  assert.throws(() => parseAgentToml(good.replace(AGENT_MARKER, "# other")), /marker/);
  assert.throws(() => parseAgentToml(good.replace('name = "us-x"\n', 'model = "m"\nname = "us-x"\n')), /Expected name/);
  assert.throws(() => parseAgentToml(`${good}model = "m"\n`), /literal string/);
  assert.throws(() => parseAgentToml(good.replace('"d"', '"d\\u0041"')), /Invalid description/);
  assert.throws(() => parseAgentToml(good.replace("body", "a ''' b")), /literal string|contain/);
});
