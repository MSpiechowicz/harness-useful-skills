import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatResources, parseCatalogArguments } from "../resources.js";

const exec = promisify(execFile);
const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../useful-skills");

async function cli(args, options = {}, entry = launcher) {
  try {
    return { code: 0, ...await exec(process.execPath, [entry, ...args], { timeout: 10_000, ...options }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("launcher discovers owned skills through the shared catalog and rejects library", async () => {
  const owned = await cli(["list", "us-run-workflow"]);
  assert.equal(owned.code, 0);
  assert.match(owned.stdout, /\/skill:us-run-workflow/);
  const library = await cli(["library", "list"]);
  assert.equal(library.code, 2);
  assert.match(library.stderr, /^useful-skills: Expected install, list, doctor, update check, update install, or help\.\nUsage:/);
  assert.doesNotMatch(library.stderr, /library/);
});

test("launcher spaced-query parsing matches extension string parsing", () => {
  assert.deepEqual(parseCatalogArguments("  list\t spaced  query  "), parseCatalogArguments(["list", "spaced", "query"]));
  assert.deepEqual(parseCatalogArguments("list spaced query"), { kind: "skills", query: "spaced query" });
  assert.deepEqual(parseCatalogArguments("list"), { kind: "skills", query: "" });
  assert.throws(() => parseCatalogArguments(["list", 7]), /arguments/);
  assert.throws(() => parseCatalogArguments(undefined), /arguments/);
  assert.deepEqual(parseCatalogArguments("list commands"), { kind: "skills", query: "commands" });
  assert.throws(() => parseCatalogArguments("library list"), /Expected list/);
  assert.match(formatResources("skills", [], "absent"), /No skills matching "absent"/);
});

test("launcher doctor and help stay passive, omit retired naming, and report argument errors", async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "us-doctor-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const doctor = await cli(["doctor"], { cwd: workspace });
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /Read-only: no setup, installation, or build/);
  assert.match(doctor.stdout, /terminal cannot inspect/i);
  assert.doesNotMatch(doctor.stdout, /anvil/i);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /anvil/i);
  assert.equal((await cli(["unknown"])).code, 2);
  assert.equal((await cli(["install", "--scope"])).code, 2);
  assert.equal((await cli(["update", "check", "--scope", "user"])).code, 2);
  assert.equal((await cli(["install", "--unknown"])).code, 2);
});

test("launcher runs when invoked through a symlinked bin path", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "us-launcher-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = path.join(directory, "useful-skills");
  await symlink(launcher, link);

  const help = await cli(["--help"], {}, link);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal((await cli(["unknown"], {}, link)).code, 2);
});

test("launcher --host keeps OMP the default and validates OpenCode arguments before running anything", async () => {
  const help = await cli(["--help"]);
  assert.match(help.stdout, /install --host opencode \[--scope user\|project\]/);
  assert.match(help.stdout, /uninstall --host opencode/);

  const omp = await cli(["doctor", "--host", "omp"]);
  assert.equal(omp.code, 0);
  assert.equal(omp.stdout, (await cli(["doctor"])).stdout);
  assert.match((await cli(["update", "check", "--host", "omp", "--scope", "user"])).stderr, /^useful-skills: --scope is not valid for this command\.\n/);

  const rejected = {
    "install --host claude": /^useful-skills: --host must be omp or opencode\.\nUsage:/,
    "install --host": /^useful-skills: --host requires a value\.\n/,
    "install --host opencode --profile work": /^useful-skills: --profile is an OMP option; it cannot be combined with --host opencode\.\n/,
    "install --host opencode --scope global": /^useful-skills: --scope must be user or project\.\n/,
    "update status --host opencode": /^useful-skills: Expected update check or update install\.\n/,
    "uninstall": /^useful-skills: uninstall needs --host opencode; for OMP run `omp plugin uninstall harness-useful-skills@harness-useful-skills`\.\n/,
    "uninstall --host omp": /omp plugin uninstall/,
  };
  for (const [args, expected] of Object.entries(rejected)) {
    const result = await cli(args.split(" "));
    assert.equal(result.code, 2, args);
    assert.match(result.stderr, expected, args);
  }
});

test("launcher OpenCode doctor and update read the given HOME without creating anything", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "us-launcher-opencode-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "share") };

  const doctor = await cli(["doctor", "--host", "opencode", "--scope", "project"], { cwd: home, env });
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /user scope/);
  assert.match(doctor.stdout, /project scope/);

  const update = await cli(["update", "check", "--host", "opencode"], { cwd: home, env });
  assert.equal(update.code, 1);
  assert.match(update.stderr, /^useful-skills: Useful Skills is not installed for OpenCode in user scope; run \.\/useful-skills install --host opencode first\.\n$/);
  assert.deepEqual(await readdir(home), []);
});

test("launcher OpenCode output never carries terminal control characters from paths", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "us-launcher-control-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = path.join(home, "evil\u001b[2J\u009bconfig");
  await mkdir(path.join(config, "opencode"), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(home, "share") };

  const doctor = await cli(["doctor", "--host", "opencode"], { cwd: home, env });

  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /no install record in .*evil \[2J config\/opencode/);
  assert.doesNotMatch(doctor.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
