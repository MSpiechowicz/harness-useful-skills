#!/usr/bin/env node
import path from "node:path";
import { createCommandRunner, errorMessage, STAGE_USAGE, WORKFLOW_USAGE } from "../command-core.js";
import { runDoctorSetup } from "../doctor-setup.js";
import { invokedDirectly } from "../entrypoint.js";
import { PACKAGE_ROOT } from "../resources.js";
import { claudePluginDataDir, resolveHostContext } from "./host-context.js";
import { claudeConfigDir } from "./models.js";
import { readClaudeWorkflow } from "./settings.js";

const HELP = [
  "Useful Skills for Claude Code",
  "/useful-skills:us-<name> — load an owned skill; natural requests also select skills by description.",
  "/useful-skills list [query] — browse owned skills.",
  `/useful-skills ${WORKFLOW_USAGE} — set the development workflow for this repository/checkout (default: enabled); outside Git, scoped to the canonical workspace.`,
  `/useful-skills ${STAGE_USAGE} — set an independent automatic stage for this Claude profile.`,
  "/useful-skills status [--json] — read repository workflow and profile stage settings, their sources, paths, and errors.",
  "/useful-skills:us-ignore-workflow — use the fast lane for one explicit request without changing saved settings.",
  "/useful-skills doctor [--check] — set up this project's memory (private facts store, pinned Graphify dependencies, graph) and report status; --check only reports status and writes nothing.",
  "/useful-skills update check|install — show how Claude Code updates this plugin.",
  "Memory: use the `memory_status`, `graph_build`, and `graph_query` MCP tools.",
  "A saved setting overrides the plugin option of the same name; without either, the setting is enabled.",
].join("\n");
const UPDATE_GUIDANCE = "Claude Code updates the plugin itself: use `/plugin` (Installed tab) or run `claude plugin update useful-skills@<marketplace>`, then `/reload-plugins`.";
const GRAPH_GUIDANCE = "Graph diagnostics in Claude Code use the `graph_build` and `graph_query` MCP tools: ask Claude to build this workspace's graph, then query it. `memory_status` reports graph state without building.";

/** Resolve the project and Claude plugin data roots, or return a printable reason they cannot be trusted. */
async function doctorHost({ environment, workspace, packageRoot }) {
  const located = await claudePluginDataDir({ environment, packageRoot });
  if (located.reason) {
    return { reason: located.reason };
  }

  try {
    return { host: await resolveHostContext({ workspace, data: located.dataDir }) };
  } catch (error) {
    // System errors embed raw paths; keep only the validation messages.
    return { reason: error?.code ? "Claude project root or plugin data directory cannot be resolved." : errorMessage(error) };
  }
}

/** Claude passes the project directory to plugin processes; anything else falls back to the working directory. */
function projectRoot({ environment, cwd }) {
  const projectDir = environment.CLAUDE_PROJECT_DIR;
  return projectDir && path.isAbsolute(projectDir) ? projectDir : cwd;
}

/** Run one `/useful-skills` subcommand for Claude Code; never throws. */
export const runCommand = createCommandRunner({
  profileLabel: "Claude",
  help: HELP,
  resourceRoot: path.join(PACKAGE_ROOT, "claude"),
  // Claude namespaces plugin skills.
  catalogUsage: usage => usage.replace(/^\/skill:/, "/useful-skills:"),
  readWorkflow: readClaudeWorkflow,
  profileDir: claudeConfigDir,
  projectRoot,
  resolveDoctorHost: doctorHost,
  runDoctor: runDoctorSetup,
  updateGuidance: UPDATE_GUIDANCE,
  graphGuidance: GRAPH_GUIDANCE,
});

if (invokedDirectly(import.meta.url)) {
  const { text, exitCode } = await runCommand(process.argv.slice(2));
  (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = exitCode;
}
