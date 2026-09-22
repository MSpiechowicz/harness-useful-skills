import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatResources, parseCatalogArguments } from "../resources.js";

const exec = promisify(execFile);
const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../useful-skills");

async function cli(args, options = {}) {
  try {
    return { code: 0, ...await exec(process.execPath, [launcher, ...args], { timeout: 10_000, ...options }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("launcher discovers owned skills and reference URIs through the shared catalog", async () => {
  const owned = await cli(["list", "us-workflow"]);
  assert.equal(owned.code, 0);
  assert.match(owned.stdout, /\/skill:us-workflow/);
  const library = await cli(["library", "list", "commands", "pr"]);
  assert.equal(library.code, 0);
  assert.match(library.stdout, /skill:\/\/us-library\/references\/ecc\/commands\/pr.md/);
});

test("launcher spaced-query parsing matches extension string parsing", () => {
  assert.deepEqual(parseCatalogArguments("  library\t list  skills spaced query  "), parseCatalogArguments(["library", "list", "skills", "spaced", "query"]));
  assert.deepEqual(parseCatalogArguments("list spaced query"), { source: "core", kind: "skills", query: "spaced query" });
  assert.deepEqual(parseCatalogArguments("list"), { source: "core", kind: "skills", query: "" });
  assert.throws(() => parseCatalogArguments(["list", 7]), /arguments/);
  assert.throws(() => parseCatalogArguments(undefined), /arguments/);
  assert.deepEqual(parseCatalogArguments("list commands"), { source: "core", kind: "skills", query: "commands" });
  assert.throws(() => parseCatalogArguments("library"), /Expected list/);
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
