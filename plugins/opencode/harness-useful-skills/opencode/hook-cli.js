#!/usr/bin/env node
/**
 * Subprocess entry for the OpenCode plugin's heavier hook work. Run with the session directory as cwd:
 *   node opencode/hook-cli.js context [--opt-out] | sync-agents | update-check
 * Each prints one JSON line `{"text": string}`; an unknown subcommand exits 2 with nothing on stdout.
 */
import { invokedDirectly } from "../entrypoint.js";
import { exitOnTermination } from "../process.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { fastLaneContext, workflowContext } from "./context.js";
import { openCodeRoutingContext, syncOpenCodeAgents } from "./models.js";
import { RUNTIME_ROOT, runtimeInstall } from "./paths.js";
import { readOpenCodeWorkflow } from "./settings.js";

const USAGE = "Usage: hook-cli.js context [--opt-out] | sync-agents | update-check";
const MODELS_UNAVAILABLE = "Useful Skills could not read or write its OpenCode model-role configuration. Dispatch the `us-*` agents the skills name; any that exist keep their earlier models.";

/** Workflow guidance for the next prompt; `--opt-out` is the user-run `/us-ignore-workflow` fast lane. */
async function context(args, { environment, cwd }) {
  const optOut = args.length === 1 && args[0] === "--opt-out";
  if (args.length > 1 || (args.length === 1 && !optOut)) {
    return undefined;
  }

  try {
    const policy = effectiveWorkflow(await readOpenCodeWorkflow({ environment, cwd }), { explicitOptOut: optOut });
    if (optOut && policy.workflow.effective === "disabled") {
      return fastLaneContext();
    }

    return workflowContext(policy);
  } catch {
    return workflowContext({ workflow: { effective: "unknown" } });
  }
}

/** Regenerate the role agents of the install this runtime belongs to; a checkout or unrecorded runtime has none. */
async function syncAgents(args, { runtimeRoot }) {
  if (args.length) {
    return undefined;
  }

  try {
    const installed = runtimeInstall(runtimeRoot);
    if (!installed) {
      return "";
    }

    return openCodeRoutingContext(syncOpenCodeAgents({ scopeRoot: installed.scopeRoot }));
  } catch {
    return MODELS_UNAVAILABLE;
  }
}

/** A quiet update check: the notice when a newer release exists, otherwise (including on any failure) empty text. */
async function updateCheck(args, { environment, runtimeRoot, updater }) {
  if (args.length) {
    return undefined;
  }

  try {
    const { checkOpenCodeUpdate } = updater ?? await import("./updater.js");
    const { updateAvailable, message } = await checkOpenCodeUpdate({ environment, runtimeRoot });
    return updateAvailable && typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

const SUBCOMMANDS = Object.freeze({ context, "sync-agents": syncAgents, "update-check": updateCheck });

/**
 * Run one hook subcommand and resolve to `{ text, exitCode }`; text is undefined for a usage error.
 * `updater` replaces opencode/updater.js in tests.
 */
export async function runHookCli(argv, { environment = process.env, cwd = process.cwd(), runtimeRoot = RUNTIME_ROOT, updater } = {}) {
  const [name, ...args] = argv;
  const subcommand = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
  const text = subcommand ? await subcommand(args, { environment, cwd, runtimeRoot, updater }) : undefined;
  return { text, exitCode: text === undefined ? 2 : 0 };
}

if (invokedDirectly(import.meta.url)) {
  exitOnTermination();
  const { text, exitCode } = await runHookCli(process.argv.slice(2));
  if (text === undefined) {
    process.stderr.write(`${USAGE}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ text })}\n`);
  }

  process.exitCode = exitCode;
}
