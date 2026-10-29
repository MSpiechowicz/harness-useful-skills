#!/usr/bin/env node
import path from "node:path";

import { commandResult, createCommandRunner, errorMessage, STAGE_USAGE, WORKFLOW_USAGE } from "../command-core.js";
import { runDoctorSetup } from "../doctor-setup.js";
import { invokedDirectly } from "../entrypoint.js";
import { exitOnTermination } from "../process.js";
import { redactText } from "../resources.js";
import { locateOpenCodeHost } from "./host-context.js";
import { RUNTIME_ROOT, runtimeInstall } from "./paths.js";
import { ensureOpenCodeConfigDir, readOpenCodeWorkflow } from "./settings.js";

const HELP = [
  "Useful Skills for OpenCode",
  "Chat commands:",
  "/useful-skills list [query] — browse owned skills; load one with the `skill` tool, or ask for it by name.",
  `/useful-skills ${WORKFLOW_USAGE} — set the development workflow for this repository/checkout (default: enabled); outside Git, scoped to the canonical workspace.`,
  `/useful-skills ${STAGE_USAGE} — set an independent automatic stage for this OpenCode profile.`,
  "/useful-skills status [--json] — read repository workflow and profile stage settings, their sources, paths, and errors.",
  "/useful-skills doctor — set up this project's memory (private facts store) and report status, whether the code graph is available and the OpenCode install.",
  "/useful-skills doctor --check — report status only; writes nothing.",
  "/useful-skills update check — check for a newer Useful Skills release.",
  "/useful-skills update install — install the latest release into the recorded scope; restart OpenCode afterwards.",
  "/useful-skills help — show this help.",
  "/us-ignore-workflow <request> — use the fast lane for that one request without changing saved settings.",
  "Memory: the `harness-useful-skills_memory_status`, `harness-useful-skills_memory_search`, and `harness-useful-skills_memory_save` tools.",
  "A saved setting wins; without one, the setting is enabled.",
  "",
  "Terminal commands (from a Useful Skills checkout):",
  "./useful-skills install --host opencode [--scope user|project]",
  "./useful-skills update check --host opencode",
  "./useful-skills update install --host opencode",
  "./useful-skills uninstall --host opencode [--scope user|project]",
  "./useful-skills doctor --host opencode",
  "./useful-skills list",
].join("\n");

/**
 * `/useful-skills update check|install` through opencode/updater.js. The updater is imported only when an update
 * command runs so other commands never load network code; `context.updater` replaces it in tests.
 */
async function update(action, { environment, packageRoot, updater }) {
  try {
    const { checkOpenCodeUpdate, installOpenCodeUpdate } = updater ?? await import("./updater.js");
    const run = action === "check" ? checkOpenCodeUpdate : installOpenCodeUpdate;
    const { message } = await run({ environment, runtimeRoot: packageRoot });
    return commandResult(redactText(message));
  } catch (error) {
    return commandResult(`Useful Skills update ${action} failed: ${errorMessage(error)}`, 1);
  }
}

async function doctorHost({ environment, workspace, packageRoot }) {
  return locateOpenCodeHost({ workspace, environment, runtimeRoot: packageRoot });
}

const runCoreCommand = createCommandRunner({
  profileLabel: "OpenCode",
  help: HELP,
  resourceRoot: path.join(RUNTIME_ROOT, "opencode"),
  catalogUsage: usage => usage.replace(/^\/skill:/, "skill tool: "),
  readWorkflow: readOpenCodeWorkflow,
  profileDir: ensureOpenCodeConfigDir,
  // OpenCode runs plugin subprocesses in the session directory.
  projectRoot: ({ cwd }) => cwd,
  resolveDoctorHost: doctorHost,
  runDoctor: runDoctorSetup,
  update,
});

/** The tokens of a doctor run that core accepts, so only a real report gets the install status appended. */
function isDoctorRun(argv) {
  if (!Array.isArray(argv) || !argv.every(token => typeof token === "string")) {
    return false;
  }

  const tokens = argv.join(" ").trim().split(/\s+/);
  return tokens[0] === "doctor" && (tokens.length === 1 || (tokens.length === 2 && tokens[1] === "--check"));
}

/** opencode/install-status.js, or undefined while that module is not part of this runtime. */
async function defaultInspectInstall() {
  try {
    return (await import("./install-status.js")).inspectOpenCodeInstall;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return undefined;
    }

    throw error;
  }
}

/** The install status section of the doctor report, as opencode/install-status.js words it; reads only. */
async function installStatus({ environment, cwd, packageRoot, inspectInstall }) {
  try {
    const inspect = inspectInstall ?? await defaultInspectInstall();
    if (!inspect) {
      return undefined;
    }

    // The inspection text opens with its own "OpenCode install (<scope> scope)" header.
    const scope = runtimeInstall(packageRoot)?.record.scope ?? "user";
    const { text } = await inspect({ scope, cwd, environment });
    return text;
  } catch (error) {
    return `OpenCode install: cannot be inspected: ${errorMessage(error)}`;
  }
}

/**
 * Run one `/useful-skills` subcommand for OpenCode; never throws. Besides the command-core options, tests may pass
 * `updater` ({ checkOpenCodeUpdate, installOpenCodeUpdate }) and `inspectInstall` (doctor).
 */
export async function runCommand(argv, options = {}) {
  const { environment = process.env, cwd = process.cwd(), packageRoot = RUNTIME_ROOT } = options;
  const context = { ...options, environment, cwd, packageRoot };
  const result = await runCoreCommand(argv, context);
  if (!isDoctorRun(argv)) {
    return result;
  }

  const status = await installStatus(context);
  return status ? commandResult(`${result.text}\n\n${status}`, result.exitCode) : result;
}

if (invokedDirectly(import.meta.url)) {
  // The plugin ends this script with SIGTERM on timeout or shutdown; child process groups and an update's
  // temporary directory would otherwise outlive it.
  exitOnTermination();
  const { text, exitCode } = await runCommand(process.argv.slice(2));
  (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = exitCode;
}
