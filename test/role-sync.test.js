import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDoctor } from "../doctor.js";
import { ROLE_AGENTS, ROLES, appendRoles, parseModelsConfig, roleCatalogueText, writeRoleCatalogue } from "../model-roles.js";
import { claudeConfigDir, modelRoutingContext, modelsConfigPath, parseSelector, syncRoleAgents } from "../claude/models.js";
import { modelRoleKeys, unmappedOmpRoles } from "../omp-roles.js";

const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const OLD = `# my notes\nmodelRoles:\n  research: haiku  # cheap\n  frontend: sonnet:high\n  backend: opus\n  implementation: sonnet\n  review: sonnet\n  security: opus:high\n  plan: opus\n  default: opus:medium\n# trailing comment\n`;

async function claudeHome(t, models) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "us-role-sync-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const file = modelsConfigPath(configDir);
  if (models !== undefined) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, models);
  }
  return { configDir, file };
}

test("sync appends a missing role once, keeping every existing line", async t => {
  const h = await claudeHome(t, OLD);
  const first = syncRoleAgents({ configDir: h.configDir });
  assert.deepEqual(first.added, ["assess"]);
  const text = await readFile(h.file, "utf8");
  assert.equal(text, OLD.replace("  default: opus:medium\n", `  default: opus:medium\n# Added by Useful Skills ${pkgVersion}: assess\n  assess: inherit\n`));
  assert.equal(parseModelsConfig(text, parseSelector).assess.model, "inherit");
  assert.match(modelRoutingContext(first), /New roles were added.*assess/);

  const second = syncRoleAgents({ configDir: h.configDir });
  assert.deepEqual(second.added, []);
  assert.equal(await readFile(h.file, "utf8"), text);
});

test("sync leaves an unparsable models file untouched", async t => {
  const bad = "modelRoles:\n  review: opus\n  nonsense here\n";
  const h = await claudeHome(t, bad);
  const result = syncRoleAgents({ configDir: h.configDir });
  assert.ok(result.error);
  assert.equal(await readFile(h.file, "utf8"), bad);
});

test("a new models file is created complete and not appended to", async t => {
  const h = await claudeHome(t);
  const result = syncRoleAgents({ configDir: h.configDir });
  assert.equal(result.created, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(Object.keys(parseModelsConfig(await readFile(h.file, "utf8"), parseSelector)), ROLES);
});

test("appendRoles keeps CRLF text and handles an empty modelRoles block", () => {
  assert.equal(appendRoles("modelRoles:\r\n  plan: x\r\n", ["assess"], () => "inherit", "1.2.3"), "modelRoles:\r\n  plan: x\r\n# Added by Useful Skills 1.2.3: assess\r\n  assess: inherit\r\n");
  assert.equal(appendRoles("modelRoles:\n", ["assess", "plan"], () => "inherit", null), "modelRoles:\n# Added by Useful Skills: assess, plan\n  assess: inherit\n  plan: inherit\n");
});

test("sync publishes roles.json once and only rewrites it on change", async t => {
  const h = await claudeHome(t, OLD);
  syncRoleAgents({ configDir: h.configDir });
  const file = path.join(path.dirname(h.file), "roles.json");
  const catalogue = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(catalogue, {
    version: 1,
    roles: ROLES.filter(role => role !== "default"),
    agents: ROLE_AGENTS,
    inheritWhenAbsent: ["assess"],
  });
  assert.equal(await readFile(file, "utf8"), roleCatalogueText());
  const before = (await stat(file)).mtimeMs;
  assert.equal(writeRoleCatalogue(path.dirname(file)), false);
  assert.equal((await stat(file)).mtimeMs, before);
  assert.equal(writeRoleCatalogue(path.join(h.configDir, "missing")), false);
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: h.configDir }), h.configDir);
});

test("doctor lists OMP roles missing from the profile config without writing it", async t => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "us-omp-roles-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const config = "theme: dark\nmodelRoles:\n  default: a/b\n  plan: a/c  # x\n  review: a/d\ntask:\n  agentModelOverrides:\n    planner: \"@plan\"\n";
  await writeFile(path.join(agentDir, "config.yml"), config);

  assert.deepEqual(modelRoleKeys(config), ["default", "plan", "review"]);
  const unmapped = unmappedOmpRoles(agentDir);
  assert.deepEqual(unmapped.map(({ role }) => role), ["research", "frontend", "backend", "implementation", "security", "assess"]);
  const text = formatDoctor({ ompRoles: unmapped });
  assert.match(text, /OMP roles not mapped: .*assess/);
  assert.match(text, /modelRoles: assess: <selector>/);
  assert.match(text, /task\.agentModelOverrides: release-assessor: "@assess"/);
  assert.equal(await readFile(path.join(agentDir, "config.yml"), "utf8"), config);

  assert.deepEqual(unmappedOmpRoles(path.join(agentDir, "none")), []);
  await writeFile(path.join(agentDir, "config.yml"), "theme: dark\n");
  assert.deepEqual(unmappedOmpRoles(agentDir), []);
  assert.doesNotMatch(formatDoctor({ ompRoles: [] }), /not mapped/);
});
