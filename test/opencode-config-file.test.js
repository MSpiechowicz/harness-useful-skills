import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { chooseConfigFile, deleteConfigFile, isSchemaOnly, mcpEntryFor, mcpSnippet, planMcpRemove, planMcpUpsert, writeConfigAtomic } from "../opencode/config-file.js";
import { createInstallSandbox } from "./helpers/opencode-install-fixture.js";

const entry = { type: "local", command: ["node", "/x/mcp-server.js"], enabled: true, timeout: 600000 };

function sandbox(t) {
  const box = createInstallSandbox();
  t.after(box.cleanup);
  const dir = path.join(box.root, "config");
  mkdirSync(dir);
  return dir;
}

test("the MCP entry points at the installed server with a long tool timeout", () => {
  const built = mcpEntryFor("/scope");
  assert.deepEqual(built.command, ["node", "/scope/plugins/harness-useful-skills/opencode/mcp-server.js"]);
  assert.equal(built.type, "local");
  assert.equal(built.enabled, true);
  assert.equal(built.timeout, 600000);
  assert.deepEqual(JSON.parse(mcpSnippet(built)), { mcp: { "harness-useful-skills": built } });
});

test("opencode.json wins, then opencode.jsonc, then a new opencode.json", (t) => {
  const dir = sandbox(t);
  assert.equal(chooseConfigFile(dir).file, path.join(dir, "opencode.json"));

  writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
  assert.equal(chooseConfigFile(dir).file, path.join(dir, "opencode.jsonc"));

  writeFileSync(path.join(dir, "opencode.json"), "{}");
  assert.equal(chooseConfigFile(dir).file, path.join(dir, "opencode.json"));
  assert.equal(chooseConfigFile(dir).warning, undefined);
});

test("the config choice warns when the other file already mentions the server", (t) => {
  const dir = sandbox(t);
  writeFileSync(path.join(dir, "opencode.json"), "{}");
  writeFileSync(path.join(dir, "opencode.jsonc"), '{ "mcp": { "harness-useful-skills": {} } }');
  const { file, warning } = chooseConfigFile(dir);
  assert.equal(file, path.join(dir, "opencode.json"));
  assert.match(warning, /opencode\.jsonc/);
});

test("upsert creates a config for a missing file", () => {
  const plan = planMcpUpsert(undefined, entry);
  assert.equal(plan.action, "create");
  assert.deepEqual(JSON.parse(plan.text).mcp, { "harness-useful-skills": entry });
  assert.ok(plan.text.endsWith("}\n"));
});

test("upsert keeps every other key and formats with two spaces", () => {
  const original = '{"model":"a/b","mcp":{"other":{"type":"remote","url":"https://x"}},"theme":"dark"}';
  const plan = planMcpUpsert(original, entry);
  assert.equal(plan.action, "update");
  assert.equal(plan.previous, undefined);
  const parsed = JSON.parse(plan.text);
  assert.equal(parsed.model, "a/b");
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.mcp.other, { type: "remote", url: "https://x" });
  assert.deepEqual(parsed.mcp["harness-useful-skills"], entry);
  assert.match(plan.text, /^\{\n {2}"model"/);
});

test("upsert reports a different existing entry and leaves a matching one alone", () => {
  const different = JSON.stringify({ mcp: { "harness-useful-skills": { type: "remote", url: "https://mine" } } });
  const replaced = planMcpUpsert(different, entry);
  assert.equal(replaced.action, "update");
  assert.deepEqual(replaced.previous, { type: "remote", url: "https://mine" });

  const matching = planMcpUpsert(JSON.stringify({ mcp: { "harness-useful-skills": entry } }), entry);
  assert.equal(matching.action, "unchanged");
});

test("upsert refuses configs it cannot edit without guessing", () => {
  for (const text of [
    '{\n  // my comment\n  "model": "a/b"\n}',
    '{"model": "a/b",}',
    "",
    "[]",
    "null",
    '"text"',
    '{"mcp": []}',
    '{"mcp": "none"}',
  ]) {
    const plan = planMcpUpsert(text, entry);
    assert.equal(plan.action, "refuse", text);
    assert.equal(typeof plan.reason, "string");
    assert.equal(plan.text, undefined);
  }
});

test("remove deletes only an entry equal to ours and drops an emptied mcp object", () => {
  const ours = JSON.stringify({ model: "a/b", mcp: { "harness-useful-skills": entry, other: { type: "remote" } } });
  const removed = planMcpRemove(ours, entry);
  assert.equal(removed.action, "remove");
  assert.deepEqual(JSON.parse(removed.text), { model: "a/b", mcp: { other: { type: "remote" } } });

  const only = planMcpRemove(JSON.stringify({ model: "a/b", mcp: { "harness-useful-skills": entry } }), entry);
  assert.deepEqual(JSON.parse(only.text), { model: "a/b" });
});

test("remove keeps a changed entry, ignores an absent one, and refuses an unparsable file", () => {
  const changed = { ...entry, timeout: 1 };
  const kept = planMcpRemove(JSON.stringify({ mcp: { "harness-useful-skills": changed } }), entry);
  assert.equal(kept.action, "keep");
  assert.deepEqual(kept.current, changed);

  assert.equal(planMcpRemove('{"mcp":{}}', entry).action, "absent");
  assert.equal(planMcpRemove(undefined, entry).action, "absent");
  assert.equal(planMcpRemove("{ // c\n}", entry).action, "refuse");
});

test("an atomic write creates a file and keeps an existing file's mode", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "opencode.json");
  writeConfigAtomic(file, "{}\n", undefined);
  assert.equal(readFileSync(file, "utf8"), "{}\n");

  chmodSync(file, 0o600);
  writeConfigAtomic(file, '{"a":1}\n', "{}\n");
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("an atomic write refuses a file that changed since it was read", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, "edited by the user");
  assert.throws(() => writeConfigAtomic(file, "{}\n", "what we read"), /changed/);
  assert.equal(readFileSync(file, "utf8"), "edited by the user");

  assert.throws(() => writeConfigAtomic(file, "{}\n", undefined), /changed/);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("an atomic write refuses symlinks, non-regular files and oversized files", (t) => {
  const dir = sandbox(t);
  const target = path.join(dir, "real.json");
  writeFileSync(target, "{}");
  const link = path.join(dir, "opencode.json");
  symlinkSync(target, link);
  assert.throws(() => writeConfigAtomic(link, "{}\n", "{}"), /symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "{}");

  const folder = path.join(dir, "folder.json");
  mkdirSync(folder);
  assert.throws(() => writeConfigAtomic(folder, "{}\n", "{}"), /regular file/);

  const big = path.join(dir, "big.json");
  writeFileSync(big, " ".repeat(1024 * 1024 + 1));
  assert.throws(() => writeConfigAtomic(big, "{}\n", ""), /1 MiB/);
  assert.equal(existsSync(path.join(dir, "big.json")), true);
});

test("an atomic write refuses a symlinked directory", (t) => {
  const dir = sandbox(t);
  const real = path.join(dir, "real");
  mkdirSync(real);
  symlinkSync(real, path.join(dir, "link"));
  assert.throws(() => writeConfigAtomic(path.join(dir, "link", "opencode.json"), "{}\n", undefined), /real directory/);
  assert.deepEqual(readdirSync(real), []);
});

test("a config holding only $schema is recognized, and deleting it is refused once it changed", (t) => {
  assert.equal(isSchemaOnly('{"$schema":"https://opencode.ai/config.json"}'), true);
  assert.equal(isSchemaOnly("{}"), true);
  assert.equal(isSchemaOnly('{"$schema":"x","model":"a/b"}'), false);
  assert.equal(isSchemaOnly('{"$schema":"x","mcp":{}}'), false);
  assert.equal(isSchemaOnly("{ // comment\n}"), false);

  const dir = sandbox(t);
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, '{"$schema":"x","model":"a/b"}');
  assert.throws(() => deleteConfigFile(file, '{"$schema":"x"}'), /changed while it was being edited/);
  assert.equal(existsSync(file), true);

  deleteConfigFile(file, '{"$schema":"x","model":"a/b"}');
  assert.equal(existsSync(file), false);
});
