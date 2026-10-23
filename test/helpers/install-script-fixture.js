import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const SCRIPT = fileURLToPath(new URL("../../install.sh", import.meta.url));
export const skip = process.platform === "win32" ? "install.sh is for macOS and Linux" : false;

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-install-script-")));
after(() => rm(base, { recursive: true, force: true }));

export const shims = path.join(base, "shims");
const CURL_STUB = `#!/bin/sh
# Records the URL (the last argument) and serves the fixture named by the environment.
for last; do :; done
printf '%s\\n' "$last" >>"$STUB_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then OUT="$2"; fi
  shift
done
case "$last" in
  https://api.github.com/*) [ -z "\${STUB_API_FAIL:-}" ] || exit 22; cp "$STUB_API" "$OUT" ;;
  https://codeload.github.com/*) [ -z "\${STUB_ARCHIVE_FAIL:-}" ] || exit 22; cp "$STUB_ARCHIVE" "$OUT" ;;
  *) exit 22 ;;
esac
`;
const NODE_STUB = `#!/bin/sh
# Pretends to be another Node.js version when asked for it, otherwise runs the real node.
if [ -n "\${FAKE_NODE_VERSION:-}" ] && [ "$1" = "-p" ]; then
  printf '%s\\n' "$FAKE_NODE_VERSION"
  exit 0
fi
exec "${process.execPath}" "$@"
`;
// The fixture's installer records how it was started, then exits with INSTALLER_EXIT.
const INSTALLER = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HOME + "/argv.json", JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }));
process.exit(Number(process.env.INSTALLER_EXIT ?? 0));
`;

await mkdir(shims);
for (const [name, body] of [["curl", CURL_STUB], ["node", NODE_STUB]]) {
  await writeFile(path.join(shims, name), body);
  await chmod(path.join(shims, name), 0o755);
}

let counter = 0;
export async function directory(name) {
  const dir = path.join(base, `${name}-${counter++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function tar(args, cwd) {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A release tarball: one top-level directory holding a minimal OpenCode release, plus the Codex files when `codex` is set. */
export async function buildRelease({ version = "1.2.3", manifestVersion = version, top = `harness-useful-skills-${version}`, codex = false, extra } = {}) {
  const work = await directory("release");
  const root = path.join(work, "tree", top);
  await mkdir(path.join(root, "plugins", "opencode", "useful-skills"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "useful-skills", version: manifestVersion }));
  await writeFile(path.join(root, "plugins", "opencode", "useful-skills", "package.json"), JSON.stringify({ version: manifestVersion }));
  await writeFile(path.join(root, "plugins", "opencode", "useful-skills.js"), "export {};\n");
  await writeFile(path.join(root, "useful-skills"), INSTALLER);
  await chmod(path.join(root, "useful-skills"), 0o755);
  if (codex) {
    const manifest = path.join(root, "plugins", "codex", ".codex-plugin");
    const runtime = path.join(root, "plugins", "codex-runtime", "useful-skills", "codex");
    await mkdir(manifest, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(path.join(manifest, "plugin.json"), JSON.stringify({ name: "useful-skills", version: manifestVersion }));
    await writeFile(path.join(runtime, "mcp-server.js"), "export {};\n");
    await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "harness-useful-skills" }));
  }
  await extra?.(root, path.join(work, "tree"));
  const archive = path.join(work, "release.tar.gz");
  tar(["-czf", archive, "-C", path.join(work, "tree"), ...(await readdir(path.join(work, "tree"))).sort()], work);
  return { archive, top };
}

/** Runs install.sh with the stub curl and node first on PATH. Returns the outcome and the observable side effects. */
export async function runInstaller({ env = {}, archive, api, bin, path: pathOverride, relativeTemp = false } = {}) {
  const work = await directory("run");
  const home = path.join(work, "home");
  const temp = path.join(work, "tmp");
  await mkdir(home);
  await mkdir(temp);
  const log = path.join(work, "curl.log");
  await writeFile(log, "");
  let apiFile = path.join(work, "api.json");
  if (api !== undefined) await writeFile(apiFile, typeof api === "string" ? api : JSON.stringify(api));
  else apiFile = "";
  const result = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    cwd: work,
    env: {
      PATH: pathOverride ?? `${bin ? `${bin}:` : ""}${shims}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: relativeTemp ? "tmp" : temp,
      STUB_LOG: log,
      STUB_ARCHIVE: archive ?? "",
      STUB_API: apiFile,
      ...env,
    },
  });
  const downloads = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const leftovers = await readdir(temp);
  const recorded = await readFile(path.join(home, "argv.json"), "utf8").then(JSON.parse, () => null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, downloads, leftovers, recorded, home };
}

/** A gzipped ustar archive with exactly these entries, so names tar would refuse to create can be listed. */
export function rawArchive(entries) {
  const blocks = [];
  for (const { name, content = "", mode = "0000644", type = content === "" && name.endsWith("/") ? "5" : "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(`${mode}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write("ustar\0" + "00", 257, "latin1");
    const sum = [...header].reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (content !== "") {
      const data = Buffer.from(content);
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export async function rawArchiveFile(entries) {
  const file = path.join(await directory("raw"), "raw.tar.gz");
  await writeFile(file, rawArchive(entries));
  return file;
}

/** A `tar` that lists the real archive in bsdtar's format with the given month word, and runs the real tar otherwise. */
export async function bsdListingStub(month) {
  const real = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  const bin = await directory("bsd-stub");
  await writeFile(path.join(bin, "tar"), `#!/bin/sh
if [ "$1" = "-tvzf" ]; then
  "${real}" -tzf "$2" | while IFS= read -r name; do
    case "$name" in */) kind=drwxr-xr-x ;; *) kind=-rw-r--r-- ;; esac
    printf '%s  0 u g 10 ${month}  1 00:00 %s\\n' "$kind" "$name"
  done
else
  exec "${real}" "$@"
fi
`);
  await chmod(path.join(bin, "tar"), 0o755);
  return bin;
}

/** A directory holding a `tar` that lists the given plain and verbose lines, so listings tar would not print can be tested. */
export async function tarListingStub({ names, verbose }) {
  const bin = await directory("tar-stub");
  const lines = (list) => list.map((line) => `printf '%s\\n' '${line}'`).join("\n");
  await writeFile(path.join(bin, "tar"), `#!/bin/sh
case "$1" in
  -tzf) ${lines(names)} ;;
  -tvzf) ${lines(verbose)} ;;
  *) echo "unexpected tar call: $*" >&2; exit 9 ;;
esac
`);
  await chmod(path.join(bin, "tar"), 0o755);
  return bin;
}

/** A directory holding a stub `codex` command, to put on PATH through the `bin` option of runInstaller. */
export async function codexStubBin() {
  const bin = await directory("codex-stub");
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "codex"), 0o755);
  return bin;
}

/** A directory that becomes the whole PATH: the stub node and the tools install.sh needs, minus the named ones. */
export async function toolsPath(omit = []) {
  const tools = await directory("tools");
  for (const name of ["sh", "tar", "gzip", "grep", "cut", "sort", "wc", "tr", "head", "find", "awk", "mktemp", "rm", "chmod", "mkdir", "cat", "cp", "uname"]) {
    if (omit.includes(name)) continue;
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, path.join(tools, name));
  }
  await symlink(path.join(shims, "node"), path.join(tools, "node"));
  if (!omit.includes("curl")) await symlink(path.join(shims, "curl"), path.join(tools, "curl"));
  return tools;
}
