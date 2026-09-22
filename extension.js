import { runUpdate } from "./updater.js";
import { executeMemory, MEMORY_PARAMETERS } from "./memory.js";
import {
  dangerousCommandReason, formatResources, listResources, parseCatalogArguments,
  redactToolResultContent, resourceInventory, safetyEnabled,
} from "./resources.js";

const DISCOVERY_HINT = "Choose relevant `us-*` skills by their descriptions. For software-development requests consult `us-workflow`; for focused audits or delivery consult the matching skill. Load only needed instructions.";
const HELP = [
  "Useful Skills for Oh My Pi",
  "/skill:us-<name> — load an owned skill; natural requests also select skills by description.",
  "/useful-skills list [query] — browse owned skills.",
  "/useful-skills library list [skills|commands|agents|rules] [query] — opt-in ECC references.",
  "/useful-skills doctor — inspect resources and memory availability without setup.",
  "/useful-skills update check|install — check or install marketplace updates.",
  "Memory: the agent follows us-memory and calls us_memory; native /memory is unchanged.",
  "Graphify setup is lazy on build/query. No startup workflow or Anvil dependency.",
  "Terminal: ./useful-skills list | doctor | library list [query] | update check|install",
].join("\n");

export default function usefulSkills(pi) {
  pi.setLabel("Useful Skills");
  let busy = false;
  let startupScheduled = false;

  function notify(ctx, message, level = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.sendMessage(
      { customType: "useful-skills", content: message, display: true, attribution: "agent" },
      { triggerTurn: false },
    );
  }

  async function update(action, ctx, quiet = false) {
    if (busy) {
      if (!quiet) notify(ctx, "A Useful Skills update operation is already running.", "warning");
      return;
    }
    busy = true;
    try {
      const report = await runUpdate(action, { cwd: ctx.cwd, profile: process.env.OMP_PROFILE });
      if (report.updated) notify(ctx, `Useful Skills updated to ${report.currentVersion}. Restart OMP to load the update.`);
      else if (report.updateAvailable) notify(ctx, `Useful Skills update available: ${report.currentVersion} → ${report.latestVersion}. Run /useful-skills update install.`, "warning");
      else if (!quiet) notify(ctx, `Useful Skills ${report.currentVersion}: ${report.message || "No newer stable release available."}`);
    } catch (error) {
      if (!quiet) notify(ctx, `Useful Skills update failed: ${error.message}`, "error");
    } finally {
      busy = false;
    }
  }

  async function doctor(ctx) {
    const [core, library, memory] = await Promise.all([
      resourceInventory(), resourceInventory({ source: "library" }),
      executeMemory({ action: "status" }, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory }),
    ]);
    notify(ctx, [
      "Useful Skills — skill-led, Anvil-free",
      `Core: ${core.skills} skills; ${core.agents} bundled agent overrides; ${core.rules} injected rules.`,
      `Optional ECC references: ${library.skills} skills, ${library.commands} commands, ${library.agents} agents, ${library.rules} rules.`,
      `Safety guard: ${safetyEnabled() ? "enabled" : "disabled by OMP_ECC_SAFETY"}; tool-result redaction enabled.`,
      `Memory status (no setup/build): ${JSON.stringify(memory)}`,
    ].join("\n"));
  }

  async function workbench(args, ctx) {
    try {
      let command = args.trim();
      if (!command && ctx.hasUI) {
        const choices = ["list", "library list", "doctor", "update check", "update install", "help"];
        command = await ctx.ui.select("Useful Skills", choices);
        if (!command) return;
      }
      if (!command || command === "help") return notify(ctx, HELP);
      if (command === "doctor") return await doctor(ctx);
      const tokens = command.split(/\s+/);
      if (tokens[0] === "update" && tokens.length === 2 && ["check", "install"].includes(tokens[1])) {
        return await update(tokens[1], ctx);
      }
      const { kind, query, source } = parseCatalogArguments(tokens);
      notify(ctx, formatResources(kind, await listResources(kind, { query, source }), query, source));
    } catch (error) {
      notify(ctx, `${error.message}\n${HELP}`, "warning");
    }
  }

  pi.registerCommand("useful-skills", {
    description: "Browse owned skills, optional references, health, and updates",
    handler: workbench,
  });
  pi.registerTool({
    name: "us_memory",
    label: "Useful Skills Memory",
    description: "Observe native memory and project graph status, explicitly build/query Graphify, or search/save durable facts. No workflow execution. Build/query may lazily install pinned managed dependencies; status never installs or writes.",
    parameters: MEMORY_PARAMETERS,
    loadMode: "essential",
    approval: args => ["status", "search"].includes(args?.action) ? "read" : args?.action === "save" ? "write" : "exec",
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await executeMemory(args, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.ok === false ? { isError: true } : {}) };
    },
  });
  pi.on("before_agent_start", event => {
    if (event.systemPrompt.some(prompt => prompt.includes(DISCOVERY_HINT))) return;
    return { systemPrompt: [...event.systemPrompt, DISCOVERY_HINT] };
  });
  pi.on("tool_call", event => {
    if (!safetyEnabled() || event.toolName !== "bash") return;
    const reason = dangerousCommandReason(event.input?.command);
    if (reason) return { block: true, reason: `Useful Skills safety guard: ${reason}. Use a reversible, explicitly approved operation instead.` };
  });
  pi.on("tool_result", event => {
    const content = redactToolResultContent(event.content);
    return content ? { content } : undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || startupScheduled) return;
    startupScheduled = true;
    ctx.setTimeout(() => update("check", ctx, true), 0);
  });
}
