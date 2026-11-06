import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = ["skills", "claude/skills", "codex/skills", "opencode/skills", "pi/skills"];

function read(host, file) {
  return readFileSync(path.join(ROOT, host, file), "utf8");
}

test("the Review guide keeps its definitions readable outside the skill", () => {
  for (const host of HOSTS) {
    const assess = read(host, "us-assess-release/SKILL.md");

    assert.doesNotMatch(assess, /tables may be omitted/, host);
    assert.match(assess, /both rubric tables copied in full/, host);
    assert.match(read(host, "us-open-pr/SKILL.md"), /always ends with the full tier and confidence tables/, host);
  }
});
