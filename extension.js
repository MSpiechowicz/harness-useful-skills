import { listSkills, runUpdate } from "./updater.js";

const HELP = [
  "Useful Skills",
  "/skill:ship-backlog-item — select an existing issue or backlog item and deliver a verified PR using GitHub CLI.",
  "/useful-skills list — list bundled skills.",
  "/useful-skills update check — check the latest stable release.",
  "/useful-skills update install — upgrade the extension and bundled skills together.",
  "Terminal: ./useful-skills list | ./useful-skills install | ./useful-skills update check | ./useful-skills update install",
  "Restart OMP after installation or updates to refresh skill discovery.",
].join("\n");
const BACK = Symbol("back");

async function select(ctx, title, choices, nested = false) {
  let back = false;
  const selected = await ctx.ui.select(title, choices.map(choice => choice.label), nested ? {
    helpText: "up/down navigate  enter select  ← back  esc cancel",
    onLeft() { back = true; },
  } : undefined);
  if (back) return BACK;
  return choices.find(choice => choice.label === selected)?.value;
}

export default function usefulSkills(pi) {
  pi.setLabel("Useful Skills");
  let busy = false;
  let startupScheduled = false;

  function notify(ctx, message, level = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.sendMessage({ customType: "useful-skills", content: message, display: true }, { triggerTurn: false });
  }

  async function update(action, ctx, quiet = false) {
    if (busy) {
      if (!quiet) notify(ctx, "A useful-skills update operation is already running.", "warning");
      return;
    }
    busy = true;
    try {
      if (action === "install") notify(ctx, "Installing Useful Skills update via the OMP plugin pipeline…");
      const report = await runUpdate(action, { cwd: ctx.cwd });
      if (report.updated) {
        notify(ctx, `Useful Skills updated to ${report.currentVersion}. Restart OMP to load the extension and refreshed skills.`);
      } else if (report.updateAvailable) {
        notify(ctx, `Useful Skills update available: ${report.currentVersion} → ${report.latestVersion}. Run /useful-skills update install.`, "warning");
      } else if (!quiet) {
        notify(ctx, `Useful Skills ${report.currentVersion}: ${report.message || "No newer stable release available."}`);
      }
    } catch (error) {
      if (!quiet) notify(ctx, `Useful Skills update failed: ${error.message}`, "error");
    } finally {
      busy = false;
    }
  }

  pi.registerCommand("useful-skills", {
    description: "Browse bundled skills and check or install marketplace updates",
    handler: async (args, ctx) => {
      let command = args.trim();
      if (!command && !ctx.hasUI) command = "help";
      while (!command || command === "update") {
        if (!ctx.hasUI) { notify(ctx, HELP); return; }
        if (!command) {
          command = await select(ctx, "Useful Skills", [
            { value: "list", label: "List" },
            { value: "update", label: "Update" },
            { value: "help", label: "Help" },
          ]);
          if (!command) return;
        }
        if (command === "update") {
          const action = await select(ctx, "Useful Skills · Update", [
            { value: "check", label: "Check" },
            { value: "install", label: "Install" },
          ], true);
          if (action === BACK) { command = ""; continue; }
          if (!action) return;
          command = `update ${action}`;
        }
      }
      if (command === "help") notify(ctx, HELP);
      else if (command === "list") {
        try {
          const skills = await listSkills();
          notify(ctx, skills.map(skill => `${skill.name} — ${skill.description}\n${skill.usage}`).join("\n\n"));
        } catch (error) {
          notify(ctx, `Could not list bundled skills: ${error.message}`, "error");
        }
      } else if (command === "update check" || command === "update install") {
        await update(command.slice(7), ctx);
      } else notify(ctx, "Usage: /useful-skills [list|help|update check|update install]", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || startupScheduled) return;
    startupScheduled = true;
    ctx.setTimeout(() => update("check", ctx, true), 0);
  });
}
