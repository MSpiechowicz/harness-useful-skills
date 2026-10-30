import assert from "node:assert/strict";
import test from "node:test";

import { ompSearchInput } from "../omp/hook-input.js";
import { isCodeToolUse, isExploration, isSourceRead } from "../omp/nudge.js";

const ctx = { cwd: "/work/app", sessionManager: { getSessionId: () => "s1" } };

test("an OMP grep or bash search of the session's project becomes a hint input", () => {
  assert.deepEqual(ompSearchInput({ toolName: "grep", input: { pattern: "fooBar" } }, ctx), {
    session_id: "s1",
    cwd: "/work/app",
    tool_name: "Grep",
    tool_input: { pattern: "fooBar" },
  });
  assert.equal(ompSearchInput({ toolName: "grep", input: { pattern: "fooBar", path: "src" } }, ctx)?.tool_name, "Grep");
  assert.equal(ompSearchInput({ toolName: "bash", input: { command: "rg -n fooBar", cwd: "/work/app/src" } }, ctx)?.tool_name, "Bash");
});

test("a search of another folder, or a command left running in the background, gets no hint input", () => {
  // the hint names the session's project, not the one searched
  assert.equal(ompSearchInput({ toolName: "grep", input: { pattern: "fooBar", path: "/other/repo" } }, ctx), undefined);
  assert.equal(ompSearchInput({ toolName: "grep", input: { pattern: "fooBar", path: "../other" } }, ctx), undefined);
  assert.equal(ompSearchInput({ toolName: "bash", input: { command: "rg fooBar", cwd: "/other/repo" } }, ctx), undefined);
  assert.equal(ompSearchInput({ toolName: "bash", input: { command: "rg fooBar", async: true } }, ctx), undefined);
  assert.equal(ompSearchInput({ toolName: "read", input: { path: "src/a.ts" } }, ctx), undefined);
  assert.equal(ompSearchInput({ toolName: "grep", input: { pattern: "fooBar" } }, { sessionManager: ctx.sessionManager }), undefined);
});

test("code tool calls are the read or write of an xd code path", () => {
  assert.equal(isCodeToolUse({ toolName: "read", input: { path: "xd://mcp__harness_memory_code_map" } }), true);
  assert.equal(isCodeToolUse({ toolName: "write", input: { path: "xd://mcp__harness_memory_code_symbol" } }), true);
  assert.equal(isCodeToolUse({ toolName: "mcp__harness_memory_code_map", input: {} }), true);
  assert.equal(isCodeToolUse({ toolName: "mcp__harness_memory_note_search", input: {} }), false);
  assert.equal(isCodeToolUse({ toolName: "read", input: { path: "xd://other" } }), false);
  assert.equal(isCodeToolUse({ toolName: "bash", input: { path: "xd://mcp__harness_memory_code_map" } }), false);
});

test("exploration commands are recognised without running anything", () => {
  for (const command of ["find src -name x", "tree", "ls -R", "ls -lR src", "wc -l src/**/*.ts", "ls src", "cd app && find . | head", "FOO=1 find .", "ls src 2>/dev/null", "ls src > /tmp/o", "ls src/lib/", "wc -l src/*.ts 2>&1"]) {
    assert.equal(isExploration(command, "/work/app"), true, command);
  }
  for (const command of ["ls -la", "ls", "wc -l README.md", "cat src/a.ts", "find /other", "ls ../src", "echo find src", "find $(pwd)", "git status", "wc -l src/main.rs", "ls src/main.rs"]) {
    assert.equal(isExploration(command, "/work/app"), false, command);
  }
});

test("only reads of source files inside the project count", () => {
  const read = where => isSourceRead({ toolName: "read", input: { path: where } }, "/work/app");
  assert.equal(read("src/a.ts"), true);
  assert.equal(read("/work/app/src/a.py:10-40"), true);
  assert.equal(read("src/a.md"), false);
  assert.equal(read("xd://src/a.ts"), false);
  assert.equal(read("/other/a.ts"), false);
  assert.equal(read("../a.ts"), false);
  assert.equal(isSourceRead({ toolName: "grep", input: { path: "src/a.ts" } }, "/work/app"), false);
});
