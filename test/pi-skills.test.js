import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = path.join(ROOT, "pi", "skills");
const AGENTS = path.join(ROOT, "pi", "agents");
const RENDERER = path.join(ROOT, "scripts", "render-pi-skills.js");
const SCRIPT = path.join(ROOT, "pi", "bin", "run-child.sh");

function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "file starts with a closed frontmatter block");
  return match[1].split("\n");
}

async function skillFiles() {
  return (await readdir(SKILLS, { recursive: true })).filter(file => file.endsWith(".md"));
}

test("rendered Pi skills match the canonical sources", async () => {
  const { stdout } = await execute(process.execPath, [RENDERER, "--check"]);
  assert.match(stdout, /^Checked \d+ Pi skill/);
});

test("every Pi skill has only name and description in its frontmatter", async () => {
  const folders = (await readdir(SKILLS, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.equal(folders.length, 22);

  for (const folder of folders) {
    const rows = frontmatterOf(await readFile(path.join(SKILLS, folder, "SKILL.md"), "utf8"));
    assert.deepEqual(rows.map(row => row.split(":")[0]), ["name", "description"], folder);
    assert.equal(rows[0], `name: ${folder}`);
    assert.match(folder, /^[a-z0-9]+(-[a-z0-9]+)*$/);

    const description = JSON.parse(rows[1].slice("description: ".length));
    assert.ok(description.length >= 1 && description.length <= 1024, `${folder} description length`);
  }
});

test("Pi skills carry no other host's wording", async () => {
  const files = await skillFiles();
  assert.ok(files.length >= 26);
  for (const file of files) {
    const text = await readFile(path.join(SKILLS, file), "utf8");
    assert.doesNotMatch(text, /skill:\/\/|\bOMP\b|\bOpenCode\b|\bCodex\b|\bClaude\b|us_memory|modelRoles|agentModelOverrides|@plan|@frontend|@backend|@implementation|subagent_type|spawn_agent|todowrite|\b[Tt]odo\b|AskUserQuestion|request_user_input|(?<!\.)\/useful-skills|the extension|--model/, file);
  }
});

test("the routing section runs the helper script and states the limits", async () => {
  const workflow = await readFile(path.join(SKILLS, "us-run-workflow", "SKILL.md"), "utf8");
  assert.match(workflow, /^## Native model routing$/m);
  for (const text of ["../../bin/run-child.sh", "mktemp", "PI_CHILD_TIMEOUT", "HEAD", "prompt rule only", "tool allowlist", "different provider", "ran inline (Pi has no worker tool)"]) {
    assert.ok(workflow.includes(text), text);
  }
  assert.doesNotMatch(workflow, /--model|\$d\b/);
});

test("every relative path in the Pi skills resolves to a file", async () => {
  const roles = ["reviewer", "security-reviewer", "release-assessor"];
  let checked = 0;
  for (const file of await skillFiles()) {
    const base = path.join(SKILLS, file.split(path.sep)[0]);
    const text = await readFile(path.join(SKILLS, file), "utf8");
    for (const [, reference] of text.matchAll(/`((?:references\/|\.\.\/)[^`\s]+)`/g)) {
      const candidates = reference.includes("<role>") ? roles.map(role => reference.replace("<role>", role)) : [reference];
      for (const candidate of candidates) {
        assert.ok(existsSync(path.resolve(base, candidate)), `${file}: ${candidate}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 10);
});

test("review, security review, and assessment point at their Pi agent files", async () => {
  const roles = { "us-review": "reviewer", "us-check-security": "security-reviewer", "us-assess-release": "release-assessor" };
  for (const [skill, role] of Object.entries(roles)) {
    const text = await readFile(path.join(SKILLS, skill, "SKILL.md"), "utf8");
    assert.ok(text.includes(`\`${role}\` role`), `${skill} names ${role}`);
    assert.ok(existsSync(path.join(AGENTS, `${role}.md`)), `${role}.md exists`);
  }

  for (const file of await readdir(AGENTS)) {
    const text = await readFile(path.join(AGENTS, file), "utf8");
    assert.ok(text.includes("read, grep, find, and ls"), file);
    assert.doesNotMatch(text, /\bbash\b|^---\n/, file);
  }
});

test("package.json points Pi at its own skills and leaves the OMP manifest alone", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, { skills: ["./pi/skills"] });
  assert.deepEqual(manifest.omp, { extensions: ["./extension.js"] });
});

const SAFETY_FLAGS = ["-p", "--no-session", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"];

async function sandbox(stubBody) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-child-"));
  const bin = path.join(dir, "bin");
  const repo = path.join(dir, "repo");
  const tmp = path.join(dir, "tmp");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(tmp);
  const argv = path.join(dir, "argv.txt");
  await writeFile(path.join(bin, "pi"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argv}"\n${stubBody}\n`);
  await chmod(path.join(bin, "pi"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => execute("git", args, { cwd: repo, env });
  await git("init", "-q");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  await writeFile(path.join(repo, "tracked.txt"), "one\n");
  await git("add", "tracked.txt");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "tracked");
  await writeFile(path.join(repo, "tracked.txt"), "one\nMODIFIED-LINE\n");
  const secret = ["gh", "p_", "x".repeat(36)].join("");
  await writeFile(path.join(repo, "untracked.env"), `TOKEN=${secret}\n`);
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, "Brief without credentials.\n");
  const run = (...args) => execute("sh", [SCRIPT, ...args], { cwd: repo, env }).then(
    result => ({ code: 0, ...result }),
    error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  return { dir, tmp, argv, brief, secret, run, git };
}

test("run-child.sh is an executable, valid shell script", () => {
  accessSync(SCRIPT, constants.X_OK);
  return execute("sh", ["-n", SCRIPT]);
});

test("run-child.sh rejects an unknown role and an invalid base without starting pi", async () => {
  const box = await sandbox("echo ok");
  try {
    const role = await box.run("planner", "HEAD", box.brief);
    assert.notEqual(role.code, 0);
    assert.match(role.stderr, /Unknown role/);
    const base = await box.run("reviewer", "--output=x", box.brief);
    assert.notEqual(base.code, 0);
    const missing = await box.run("reviewer", "no-such-ref", box.brief);
    assert.notEqual(missing.code, 0);
    assert.equal(existsSync(box.argv), false, "pi was never started");
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
});

test("run-child.sh starts a locked-down child with the change attached and cleans up", async () => {
  const box = await sandbox("echo ok");
  try {
    const result = await box.run("release-assessor", "HEAD", box.brief, "--ui");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "ok");

    const args = (await readFile(box.argv, "utf8")).split("\n");
    for (const flag of SAFETY_FLAGS) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.doesNotMatch(args[args.indexOf("--tools") + 1], /bash|edit|write/);
    assert.ok(!args.includes("--model"));

    const role = path.join(ROOT, "pi", "agents", "release-assessor.md");
    assert.equal(path.resolve(args[args.indexOf("--append-system-prompt") + 1]), role);
    const attached = args.filter(arg => arg.startsWith("@")).map(arg => path.resolve(arg.slice(1)));
    for (const file of [role, path.join(SKILLS, "us-write-concisely", "SKILL.md"), path.join(SKILLS, "us-assess-release", "references", "rubric.md"), path.join(SKILLS, "us-keep-ui-consistent", "SKILL.md"), box.brief]) {
      assert.ok(attached.includes(file), file);
    }

    const patchName = args.find(arg => arg.startsWith("@") && arg.endsWith("diff.patch"));
    assert.ok(patchName, "diff attachment");
    // The stub cannot read the patch after the script exits, so rerun with a stub that copies it.
    const copy = path.join(box.dir, "patch-copy.txt");
    await writeFile(path.join(box.dir, "bin", "pi"), `#!/bin/sh\nfor a in "$@"; do case "$a" in @*diff.patch) cp "\${a#@}" "${copy}";; esac; done\necho ok\n`);
    const second = await box.run("reviewer", "HEAD", box.brief);
    assert.equal(second.code, 0, second.stderr);
    const patch = await readFile(copy, "utf8");
    assert.ok(patch.includes("+MODIFIED-LINE"));
    assert.ok(patch.includes("untracked.env"));
    assert.ok(!patch.includes(box.secret));

    assert.deepEqual(await readdir(box.tmp), [], "temporary directory removed");
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
});

test("run-child.sh passes git only a commit ID, attaches staged changes once, and pins a relative brief", async () => {
  const box = await sandbox("echo ok");
  try {
    const repo = path.join(box.dir, "repo");
    // A ref name that git diff would read as an option if it were passed through.
    await box.git("update-ref", "refs/tags/--output=pwned.txt", "HEAD");
    await writeFile(path.join(repo, "staged.txt"), "STAGED-LINE\n");
    await box.git("add", "staged.txt");
    const copy = path.join(box.dir, "patch-copy.txt");
    await writeFile(path.join(box.dir, "bin", "pi"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${box.argv}"\nfor a in "$@"; do case "$a" in @*diff.patch) cp "\${a#@}" "${copy}";; esac; done\necho ok\n`);

    // The brief is named relative to a subdirectory, not to the repository root.
    const sub = path.join(repo, "sub");
    await mkdir(sub);
    await writeFile(path.join(sub, "brief.md"), "Relative brief.\n");
    const result = await execute("sh", [SCRIPT, "reviewer", "refs/tags/--output=pwned.txt", "brief.md"], { cwd: sub, env: { ...process.env, PATH: `${path.join(box.dir, "bin")}:${process.env.PATH}`, TMPDIR: box.tmp, GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.equal(result.stdout.trim(), "ok");
    assert.equal(existsSync(path.join(repo, "pwned.txt")), false, "no file written through a ref name");

    const patch = await readFile(copy, "utf8");
    assert.equal(patch.split("+STAGED-LINE").length - 1, 1, "staged change attached once");
    const args = (await readFile(box.argv, "utf8")).split("\n");
    assert.ok(args.includes(`@${path.join(sub, "brief.md")}`), "brief attached by absolute path");
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
});

test("run-child.sh rejects a timeout that is not a whole number of at least one second", async () => {
  const box = await sandbox("echo ok");
  try {
    for (const value of ["5; touch x", "0", "000"]) {
      const result = await execute("sh", [SCRIPT, "reviewer", "HEAD", box.brief], { cwd: path.join(box.dir, "repo"), env: { ...process.env, PATH: `${path.join(box.dir, "bin")}:${process.env.PATH}`, PI_CHILD_TIMEOUT: value } }).then(() => ({ code: 0 }), error => ({ code: error.code, stderr: error.stderr }));
      assert.equal(result.code, 64, value);
    }
    assert.equal(existsSync(box.argv), false, "pi was never started");
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
});

test("run-child.sh stops the child when it is terminated", async () => {
  const box = await sandbox("");
  const marker = path.join(box.dir, "child-got-term");
  await writeFile(path.join(box.dir, "bin", "pi"), `#!/bin/sh\ntrap 'touch "${marker}"; exit 143' TERM\nsleep 30 & wait $!\n`);
  try {
    const started = Date.now();
    const env = { ...process.env, PATH: `${path.join(box.dir, "bin")}:${process.env.PATH}`, TMPDIR: box.tmp, GIT_CONFIG_GLOBAL: "/dev/null" };
    const proc = execFile("sh", [SCRIPT, "reviewer", "HEAD", box.brief], { cwd: path.join(box.dir, "repo"), env });
    await new Promise(resolve => setTimeout(resolve, 1000));
    proc.kill("SIGTERM");
    const code = await new Promise(resolve => proc.on("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
    assert.equal(code, 143);
    assert.ok(Date.now() - started < 15000, "the script did not wait for the child");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(marker), "the child received TERM");
    assert.deepEqual(await readdir(box.tmp), [], "temporary directory removed");
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
});

test("run-child.sh never echoes a failed child's error text", async () => {
  const token = ["sk", "-", "a".repeat(30)].join("");
  for (const [body, hint] of [
    [`echo "auth failed for ${token} https://user:pass@host password = hunter2" >&2\nexit 1`, /Run pi yourself/],
    ["echo 'No API key found for the selected model.' >&2\nexit 1", /no provider login/],
  ]) {
    const box = await sandbox(body);
    try {
      const result = await box.run("reviewer", "HEAD", box.brief);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /could not be met/);
      assert.match(result.stderr, hint);
      for (const leaked of [token, "hunter2", "user:pass"]) assert.ok(!result.stderr.includes(leaked), leaked);
    } finally {
      await rm(box.dir, { recursive: true, force: true });
    }
  }
});

test("run-child.sh reports a failed or silent child as a stage that could not be met", async () => {
  for (const [body, pattern] of [["echo boom >&2\nexit 1", /could not be met/], ["exit 0", /could not be met/], ["exit 124", /timed out/]]) {
    const box = await sandbox(body);
    try {
      const result = await box.run("security-reviewer", "HEAD", box.brief);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, pattern);
      assert.deepEqual(await readdir(box.tmp), [], "temporary directory removed");
    } finally {
      await rm(box.dir, { recursive: true, force: true });
    }
  }
});
