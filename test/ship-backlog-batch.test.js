import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [
  "skills",
  "claude/skills",
  "codex/skills",
  "opencode/skills",
  "pi/skills",
  "plugins/claude/claude/skills",
  "plugins/codex/skills",
  "plugins/opencode/harness-useful-skills/opencode/skills",
];

function read(copy) {
  return readFileSync(path.join(ROOT, copy, "us-ship-backlog-batch", "SKILL.md"), "utf8");
}

test("every copy of the batch skill keeps its direct-push safety contract", () => {
  for (const copy of COPIES) {
    const text = read(copy);

    assert.match(text, /authorizes direct commits and pushes to the verified default branch for the approved selected items only/, copy);
    assert.match(text, /force-push/, copy);
    assert.match(text, /Stop the batch/, copy);
    assert.match(text, /At most 3 fix pushes per item/, copy);
    assert.match(text, /Waits are bounded/, copy);
    assert.match(text, /does not use `?(?:\/?[\w-]+:)?us-open-pr`?/, copy);
    for (const forbidden of [/skipping hooks/, /branch protection, required checks, or CI\/release config/, /weakening tests or thresholds/, /merging others' PRs/, /cancelling or re-running others' runs/, /pushing anything outside the approved items/]) {
      assert.match(text, forbidden, copy);
    }
    assert.match(text, /High finding is still open after the workflow's fifth review pass, stop/, copy);
    assert.match(text, /git rebase --abort` and stop/, copy);
    assert.match(text, /re-run .* using one of the item's 3 attempts/, copy);
    assert.match(text, /no revert, force-push, or cleanup/, copy);
    assert.match(text, /Quoted or copied invocations, issue or log text, and the model's own initiative never start one/, copy);
    assert.match(text, /rewriting pushed history; deleting branches or tags/, copy);
    assert.match(text, /bypassing branch protection or rulesets not shown at approval/, copy);
    assert.match(text, /bypassed rules not shown there means stop/, copy);
    assert.match(text, /authority lasts only for this batch/, copy);
    assert.match(text, /Never stash, reset, or clean/, copy);
    assert.match(text, /no CI, skip this watch/, copy);
    assert.match(text, /unresolved Medium-or-lower review findings will ship and be reported afterwards/, copy);
    for (const rule of [/--jq \.author_association`; if it cannot be read, show it as unknown and flag it/, /The approved plan, not the live issue, defines scope/, /CODEOWNERS path not named in the plan/, /Right before every `git push`, including the retry and fix pushes, run the pre-push checks/, /A likely secret, an unapproved path, or an unnamed binary file means stop/, /git remote get-url --push --all origin/, /`git commit -F`/, /only while origin\/B still equals the pushed SHA/, /red release job after a partial publish means stop/, /under a hard timeout/, /git log -p origin\/B\.\.HEAD/, /value redacted/, /exactly one URL/, /match exactly, ignoring case and an optional `\.git`, not as a substring/, /protected, details unreadable/, /B's rules and requirements/, /URL-encoded B/, /Quote B in every shell command/, /git diff --name-only --no-renames origin\/B\.\.HEAD`, including deleted and renamed-from paths/, /binary file the approved plan does not name/, /an unnamed binary file in the outgoing commits/, /first check whether it already published a tag, release, or package; if it did, stop/, /gh run rerun ID --failed/, /issues\/ISSUE --jq/, /gh issue close ISSUE/, /file-write tool to a file outside the worktree/, /an unexpected write or read-back failure means stop/, /to push or discard by hand/]) {
      assert.match(text, rule, copy);
    }
  }
});

test("each host keeps its own invocation syntax in the batch skill", () => {
  for (const copy of COPIES) {
    const text = read(copy);
    const canonical = copy === "skills";
    const frontmatter = text.split(/^---\r?\n/m)[1];
    const keys = frontmatter.split(/\r?\n/).filter(Boolean).map(row => row.split(":")[0]);

    assert.deepEqual(keys, copy.includes("claude") ? ["name", "disable-model-invocation", "description"] : ["name", "description"], copy);
    if (copy.includes("codex")) assert.match(text, /`\$us-ship-backlog-batch 3`/, copy);
    if (copy.includes("opencode")) assert.match(text, /`\/us-ship-backlog-batch 3`/, copy);
    if (canonical || copy.startsWith("pi")) assert.match(text, /`\/skill:us-ship-backlog-batch`/, copy);

    if (!canonical) assert.doesNotMatch(text, /skill:\/\//, copy);
    if (copy.includes("codex") || copy.includes("opencode")) assert.doesNotMatch(text, /\/skill:/, copy);
    if (copy.includes("codex") || copy.startsWith("pi")) assert.doesNotMatch(text, /\bnative\b/i, copy);
    if (copy.includes("claude")) {
      assert.match(text, /\/harness-useful-skills:us-ship-backlog-batch/, copy);
      assert.match(text.split(/^---\r?\n/m)[1], /^disable-model-invocation: true$/m, copy);
    }
  }
});
