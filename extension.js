import { runUpdate } from "./updater.js";
import {
  ECC_UPSTREAM,
  PACKAGE_ROOT,
  dangerousCommandReason,
  listResources,
  loadPortableRules,
  redactToolResultContent,
  resourceInventory,
  safetyEnabled,
} from "./ecc-runtime.js";

const HELP = [
  "Useful Skills · ECC for Oh My Pi",
  "/skill:<name> — invoke one of the bundled ECC or Useful Skills workflows.",
  "/ecc list [skills|commands|agents|rules] [query] — browse the OMP catalog.",
  "/ecc doctor — inspect the installed OMP resource pack and native integrations.",
  "/ecc memory status|search <query>|save <fact> — use OMP's configured memory backend.",
  "/useful-skills update check|install — check or install marketplace updates.",
  "Terminal: ./useful-skills list | ./useful-skills update check | ./useful-skills update install",
  "This package ships only the Oh My Pi integration; restart OMP after updates.",
].join("\n");

const BACK = Symbol("back");
async function select(ctx, title, choices, nested = false) {
  let back = false;
  const selected = await ctx.ui.select(title, choices.map((choice) => choice.label), nested ? {
    helpText: "up/down navigate  enter select  ← back  esc cancel",
    onLeft() {
      back = true;
    },
  } : undefined);
  if (back) return BACK;
  return choices.find((choice) => choice.label === selected)?.value;
}

function formatResources(kind, resources, query) {
  if (resources.length === 0) {
    return `No ${kind} match${query ? `ing ${JSON.stringify(query)}` : ""}.`;
  }
  const limit = kind === "skills" ? 100 : 80;
  const shown = resources.slice(0, limit);
  const lines = shown.map((resource) => {
    const detail = resource.description ? ` — ${resource.description}` : "";
    return `  ${resource.name}${detail}\n    ${resource.usage ?? resource.path}`;
  });
  if (resources.length > limit) lines.push(`  … ${resources.length - limit} more; add a query to narrow the catalog.`);
  return [`ECC ${kind} (${resources.length}):`, ...lines].join("\n");
}

function formatMemoryStatus(status) {
  if (!status) return "Memory: unavailable.";
  const state = status.active ? "active" : "inactive";
  const capabilities = [
    status.searchable ? "search" : undefined,
    status.writable ? "save" : undefined,
  ].filter(Boolean).join(", ") || "none";
  const details = [
    `Memory backend: ${status.backend ?? "unknown"} (${state})`,
    `Capabilities: ${capabilities}`,
    status.scope ? `Scope: ${status.scope}` : undefined,
    status.database ? `Database: ${status.database}` : undefined,
    status.message ? `Message: ${status.message}` : undefined,
    status.error ? `Error: ${status.error}` : undefined,
  ].filter(Boolean);
  return details.join("\n");
}

function memoryHelp() {
  return [
    "OMP memory wrapper:",
    "/ecc-memory status",
    "/ecc-memory search <query>",
    "/ecc-memory save <durable fact>",
    "The native /memory commands remain authoritative.",
  ].join("\n");
}

export default function usefulSkills(pi) {
  pi.setLabel("Useful Skills · ECC");
  let busy = false;
  let startupScheduled = false;
  let rulesPromise;

  function notify(ctx, message, level = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.sendMessage(
      { customType: "useful-skills", content: message, display: true, attribution: "agent" },
      { triggerTurn: false },
    );
  }

  async function update(action, ctx, quiet = false) {
    if (busy) {
      if (!quiet) notify(ctx, "An ECC update operation is already running.", "warning");
      return;
    }
    busy = true;
    try {
      if (action === "install") notify(ctx, "Installing the Useful Skills · ECC update via the OMP plugin pipeline…");
      const report = await runUpdate(action, { cwd: ctx.cwd });
      if (report.updated) {
        notify(ctx, `Useful Skills · ECC updated to ${report.currentVersion}. Restart OMP to load the refreshed pack.`);
      } else if (report.updateAvailable) {
        notify(ctx, `Useful Skills · ECC update available: ${report.currentVersion} → ${report.latestVersion}. Run /useful-skills update install.`, "warning");
      } else if (!quiet) {
        notify(ctx, `Useful Skills · ECC ${report.currentVersion}: ${report.message || "No newer stable release available."}`);
      }
    } catch (error) {
      if (!quiet) notify(ctx, `Useful Skills · ECC update failed: ${error.message}`, "error");
    } finally {
      busy = false;
    }
  }

  async function doctor(ctx) {
    try {
      const inventory = await resourceInventory({ root: PACKAGE_ROOT });
      let memory;
      if (ctx.memory) {
        try {
          memory = await ctx.memory.status();
        } catch (error) {
          memory = { backend: "error", active: false, error: error.message };
        }
      }
      notify(ctx, [
        "ECC for Oh My Pi",
        `Upstream: ${ECC_UPSTREAM.repository} ${ECC_UPSTREAM.version} @ ${ECC_UPSTREAM.commit.slice(0, 12)}`,
        `Resources: ${inventory.skills} skills, ${inventory.commands} commands, ${inventory.agents} agents, ${inventory.rules} rules`,
        "Extension: before-agent rules, destructive-command guard, tool-result secret redaction",
        `Safety guard: ${safetyEnabled() ? "enabled" : "disabled by OMP_ECC_SAFETY"}`,
        formatMemoryStatus(memory ?? { backend: "unavailable", active: false, message: "OMP memory runtime is not exposed in this session." }),
        "Adapters: OMP only; no Claude, Codex, Pi, or external-harness runtime is bundled.",
      ].join("\n"));
    } catch (error) {
      notify(ctx, `Could not inspect the ECC pack: ${error.message}`, "error");
    }
  }

  async function memoryCommand(args, ctx) {
    if (!ctx.memory) {
      notify(ctx, "OMP memory is unavailable in this session. Configure a native OMP memory backend first.", "warning");
      return;
    }
    const [action = "status", ...rest] = args.trim().split(/\s+/);
    try {
      if (action === "status") {
        notify(ctx, formatMemoryStatus(await ctx.memory.status()));
      } else if (action === "search") {
        const query = rest.join(" ").trim();
        if (!query) {
          notify(ctx, "Usage: /ecc-memory search <query>", "warning");
          return;
        }
        const result = await ctx.memory.search(query, { limit: 8 });
        const lines = [`Memory search: ${result.query} (${result.count})`];
        if (result.message) lines.push(result.message);
        for (const item of result.items ?? []) {
          lines.push(`- ${item.id ? `${item.id}: ` : ""}${item.content}`);
        }
        notify(ctx, lines.join("\n"));
      } else if (action === "save") {
        const content = rest.join(" ").trim();
        if (!content) {
          notify(ctx, "Usage: /ecc-memory save <durable fact>", "warning");
          return;
        }
        const result = await ctx.memory.save({ content, source: "ecc-omp" });
        notify(ctx, result.message || `Saved ${result.stored ?? 0} memory item(s).`);
      } else {
        notify(ctx, memoryHelp(), "warning");
      }
    } catch (error) {
      notify(ctx, `OMP memory operation failed: ${error.message}`, "error");
    }
  }

  async function listCatalog(kind, query, ctx) {
    try {
      const resources = await listResources(kind, { root: PACKAGE_ROOT, query });
      notify(ctx, formatResources(kind, resources, query));
    } catch (error) {
      notify(ctx, `Could not list ECC ${kind}: ${error.message}`, "error");
    }
  }

  async function chooseUpdate(ctx) {
    if (!ctx.hasUI) {
      notify(ctx, "Usage: /useful-skills update check|install", "warning");
      return;
    }
    const action = await select(ctx, "Useful Skills · Update", [
      { value: "check", label: "Check" },
      { value: "install", label: "Install" },
    ], true);
    if (action !== BACK && action) await update(action, ctx);
  }

  async function workbench(args, ctx) {
    let command = args.trim();
    if (!command && !ctx.hasUI) command = "help";
    while (!command) {
      command = await select(ctx, "Useful Skills · ECC", [
        { value: "list skills", label: "List skills" },
        { value: "list commands", label: "List commands" },
        { value: "list agents", label: "List agents" },
        { value: "list rules", label: "List rules" },
        { value: "doctor", label: "Doctor" },
        { value: "memory status", label: "Memory" },
        { value: "update", label: "Update" },
        { value: "help", label: "Help" },
      ]);
      if (command === "update") {
        await chooseUpdate(ctx);
        command = "";
      } else if (command === BACK || !command) {
        return;
      }
    }
    if (command === "help") {
      notify(ctx, HELP);
      return;
    }
    if (command === "doctor") {
      await doctor(ctx);
      return;
    }
    if (command === "update") {
      await chooseUpdate(ctx);
      return;
    }
    if (command === "update check" || command === "update install") {
      await update(command.slice(7), ctx);
      return;
    }
    if (command === "memory" || command.startsWith("memory ")) {
      await memoryCommand(command.slice("memory".length), ctx);
      return;
    }
    const listMatch = /^(?:list|catalog)(?:\\s+(skills|commands|agents|rules))?(?:\\s+(.+))?$/.exec(command);
    if (listMatch) {
      await listCatalog(listMatch[1] ?? "skills", listMatch[2] ?? "", ctx);
      return;
    }
    notify(ctx, "Usage: /ecc [list [skills|commands|agents|rules] [query]|doctor|memory status|update check|update install|help]", "warning");
  }

  pi.registerCommand("useful-skills", {
    description: "Browse the OMP-native Useful Skills and ECC resource pack",
    handler: (args, ctx) => workbench(args, ctx),
  });
  pi.registerCommand("ecc", {
    description: "Browse ECC skills, commands, agents, rules, memory, and updates",
    handler: (args, ctx) => workbench(args, ctx),
  });
  pi.registerCommand("ecc-doctor", {
    description: "Inspect the OMP-native ECC resource pack and integrations",
    handler: (_args, ctx) => doctor(ctx),
  });
  pi.registerCommand("ecc-memory", {
    description: "Use OMP's configured memory backend from the ECC workflow",
    handler: (args, ctx) => memoryCommand(args, ctx),
  });

  pi.on("before_agent_start", async (event) => {
    rulesPromise ??= loadPortableRules({ root: PACKAGE_ROOT });
    const rules = await rulesPromise;
    if (!rules || event.systemPrompt.some((prompt) => prompt.includes("<ecc-omp-engineering-rules>"))) return;
    return { systemPrompt: [...event.systemPrompt, rules] };
  });

  pi.on("tool_call", (event) => {
    if (!safetyEnabled() || event.toolName !== "bash") return;
    const reason = dangerousCommandReason(event.input?.command);
    if (reason) {
      return {
        block: true,
        reason: `ECC OMP safety guard: ${reason}. Use a reversible, explicitly approved operation instead.`,
      };
    }
  });

  pi.on("tool_result", (event) => {
    const content = redactToolResultContent(event.content);
    return content ? { content } : undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || startupScheduled) return;
    startupScheduled = true;
    ctx.setTimeout(() => update("check", ctx, true), 0);
  });
}
