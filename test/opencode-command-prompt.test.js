import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCommandMatcher } from "../opencode/command-prompt.js";

async function matcher(templates) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-command-prompt-"));
  for (const [name, markdown] of Object.entries(templates)) {
    await writeFile(path.join(directory, `${name}.md`), markdown);
  }
  return { match: await loadCommandMatcher(directory), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("a prompt is the command template optionally followed by what the user typed", async t => {
  const { match, cleanup } = await matcher({
    "useful-skills": "---\ndescription: x\n---\n\nBody line one.\n\nBody line two.\n",
    "us-ignore-workflow": "---\ndescription: y\n---\n\nHandle this:\n\n$ARGUMENTS\n",
  });
  t.after(cleanup);

  assert.deepEqual(match("Body line one.\n\nBody line two."), { name: "useful-skills", args: "" });
  assert.deepEqual(match("Body line one.\n\nBody line two.\n\nworkflow  enabled\nmore"), { name: "useful-skills", args: "workflow  enabled\nmore" });
  assert.deepEqual(match("Handle this:"), { name: "us-ignore-workflow", args: "" });
  assert.deepEqual(match("Handle this:\n\nfix a typo"), { name: "us-ignore-workflow", args: "fix a typo" });

  for (const other of ["Body line one.\n\nBody line two.x", "Body line one.", "see Handle this:", "", undefined, 7]) {
    assert.equal(match(other), undefined, String(other));
  }
});

test("a template that is missing, empty, or has a placeholder in the middle is never matched", async t => {
  const { match, cleanup } = await matcher({
    "useful-skills": "---\ndescription: x\n---\n\n   \n",
    "us-ignore-workflow": "---\ndescription: y\n---\nBefore $ARGUMENTS after\n",
  });
  t.after(cleanup);

  for (const text of ["", "Before", "Before fix after", "Before $ARGUMENTS after"]) {
    assert.equal(match(text), undefined, text);
  }
});

test("an unreadable commands directory matches nothing", async () => {
  const match = await loadCommandMatcher(path.join(os.tmpdir(), "useful-skills-no-such-directory"));
  assert.equal(match("anything"), undefined);
});
