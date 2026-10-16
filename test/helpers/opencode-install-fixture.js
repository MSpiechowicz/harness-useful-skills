import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REAL_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "opencode", "agents");

/** Temp HOME/XDG directories and a project directory, so an install never touches the real OpenCode setup. */
export function createInstallSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "us-opencode-install-"));
  const environment = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    PATH: process.env.PATH,
  };
  const cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return {
    root,
    environment,
    cwd,
    configDir: path.join(environment.XDG_CONFIG_HOME, "opencode"),
    dataDir: path.join(environment.XDG_DATA_HOME, "opencode", "useful-skills"),
    bundleRoot: path.join(root, "bundle"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A small OpenCode bundle: the plugin entry plus a runtime tree with the real agent templates, one skill and
 * the two commands. `files` adds or overrides runtime-tree files; a null value drops one.
 */
export function writeBundle(bundleRoot, { version = "1.0.0", files = {} } = {}) {
  rmSync(bundleRoot, { recursive: true, force: true });
  const runtime = path.join(bundleRoot, "useful-skills");
  mkdirSync(path.join(runtime, "opencode"), { recursive: true });
  cpSync(REAL_AGENTS, path.join(runtime, "opencode", "agents"), { recursive: true });

  const content = {
    "package.json": `${JSON.stringify({ name: "useful-skills-opencode", private: true, type: "module", version })}\n`,
    "opencode/mcp-server.js": `// mcp ${version}\n`,
    "opencode/v1.js": `export const UsefulSkills = async () => ({}); // ${version}\n`,
    "opencode/skills/us-plan/SKILL.md": `---\nname: us-plan\n---\nPlan ${version}\n`,
    "opencode/skills/us-plan/references/brief.md": "Brief\n",
    "opencode/commands/useful-skills.md": "Fallback\n",
    "opencode/commands/us-ignore-workflow.md": "Ignore\n",
    ...files,
  };
  for (const [rel, text] of Object.entries(content)) {
    if (text === null) continue;
    const target = path.join(runtime, ...rel.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  writeFileSync(path.join(bundleRoot, "useful-skills.js"), 'export { UsefulSkills } from "./useful-skills/opencode/v1.js";\n');
}
