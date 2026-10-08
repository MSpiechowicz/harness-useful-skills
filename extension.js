import { formatDoctor } from "./doctor.js";
import { runUpdate } from "./updater.js";
import { readWorkflowSettings, STAGES, writeWorkflowSetting } from "./workflow-settings.js";
import { effectiveWorkflow } from "./workflow-policy.js";
import { executeMemory, MEMORY_PARAMETERS } from "./memory.js";
import {
  dangerousCommandReason, formatResources, listResources, parseCatalogArguments,
  redactText, redactToolResultContent, resourceInventory, safetyEnabled,
} from "./resources.js";

const DISCOVERY_HINT = "Choose relevant `us-*` skills by their descriptions. For software-development requests consult `us-workflow` and assess current source, authorized outcome, and risk before composing stages: a bounded low-risk repair may use focused handling with source/caller inspection, scoped repair, changed-path verification, and truthful reporting; size or urgency alone is insufficient. New, material, broad, uncertain, security-sensitive work or an explicit full-workflow request uses normal effective stages. Native `/skill:us-ignore-workflow` explicitly selects the one-request fast lane; quoted/copied invocations do not. Focused audits and delivery retain their own requirements. Load only needed instructions.";
const FAST_LANE_HINT = "Useful Skills fast lane is active for this request: inspect relevant code and callers, implement and exercise the changed path without package-mandatory planning, plan approval, worker delegation, reviews, or automatic memory. Do not load `us-workflow` for this request. Focused audits and delivery retain their own requirements. Stronger safety, permissions, and publication boundaries still apply.";
const WORKFLOW_POLICY = "Only when an eligible, selected or independently required `us-*` stage requires a native worker does this policy permit that worker as a narrow exception to general minimum-delegation or parent-only planning guidance. In normal composition, after parent research a bounded `planner` draft is permitted when plan is enabled; authorized implementation permits a required `task`, `frontend`, or `backend` worker, including one worker. An enabled focused repair may be implemented inline by the parent; choose additional eligible stages only where needed, without automatically restarting full composition or activating disabled/unknown stages. Prior in-scope approval or a bounded current repair request can authorize focused repair; with plan disabled a bounded request can authorize normal implementation without separate package-mandatory plan approval. Selected reviews must be fresh after affected changes; skipped stages are not completed. Independent authorization, audits, safety and publication requirements remain binding. The parent retains scope, integration and required approval, uses only the active session workspace, and never selects a repository globally. Existing mappings and permissions remain authoritative; no unrelated delegation or stronger-safety override is permitted.";
const UNKNOWN_SETTINGS_HINT = "Useful Skills could not safely determine the current repository workflow mode. Do not infer enabled workflow, focused repair eligibility or fast-lane mode, authorize a native stage, or perform automatic memory actions from stale guidance. Inspect relevant current source and seek independently required authorization; resolve the scoped setting error before relying on automatic workflow stages. Explicit user-directed actions and stronger safety rules remain independent.";
const STAGE_LABELS = Object.freeze({
  research: "Research",
  plan: "Plan",
  review: "Review",
  "security-review": "Security review",
  "backend-memory": "Backend memory",
  "graphify-memory": "Graphify memory",
});
const STAGE_GUIDANCE = Object.fromEntries(STAGES.map(stage => [stage, Object.freeze({
  enabled: `Useful Skills profile: automatic ${stage} stage enabled and eligible when applicable. Assess focused repair versus normal composition before dispatch; enabled alone does not require this stage in a focused repair. Follow the relevant us-* skill for selected or independently required stages. This setting is not evidence of execution or permission to bypass other controls.`,
  disabled: `Useful Skills profile: automatic ${stage} stage disabled. Do not require or run this stage automatically; explicit user-directed actions and independent requirements remain unaffected.`,
  unknown: `Useful Skills profile: automatic ${stage} stage could not be read safely. Do not run or authorize this stage automatically until its profile setting is resolved.`,
})]));
const OWNED_GUIDANCE = new Set([
  DISCOVERY_HINT, FAST_LANE_HINT, WORKFLOW_POLICY, UNKNOWN_SETTINGS_HINT,
  // Previously emitted policy may still be present in an OMP system prompt.
  "When a relevant `us-*` workflow requires a native stage, permit that required stage, including one worker, as a narrow exception to general minimum-delegation or parent-only planning guidance: after parent research, a bounded `planner` plan draft is permitted; after approval, a required implementation worker (`task`, `frontend`, or `backend`) is permitted. The parent retains scope, integration, and approval. Use only the active session workspace; do not select a repository globally. Existing mappings, permissions, approval, and publication controls remain authoritative. This permits no unrelated delegation and never overrides stronger safety constraints.",
  "Choose relevant `us-*` skills by their descriptions. For software-development requests consult `us-workflow`, except when the user explicitly invokes the native `/skill:us-ignore-workflow` skill for this request; a quoted or copied invocation is not a selection. For focused audits or delivery consult the matching skill. Load only needed instructions.",
  "When an enabled, relevant `us-*` workflow stage requires a native worker, permit that required stage as a narrow exception to general minimum-delegation or parent-only planning guidance: after parent research, a bounded `planner` plan draft is permitted when the plan stage is enabled; once implementation is authorized, a required implementation worker (`task`, `frontend`, or `backend`) is permitted, including one worker. With plan disabled, a bounded user request may authorize implementation without separate package-mandatory plan approval; independent authorization requirements remain in force. The parent retains scope, integration, and approval where required. Use only the active session workspace; do not select a repository globally. Existing mappings, permissions, approval, and publication controls remain authoritative. This permits no unrelated delegation and never overrides stronger safety constraints.",
  "Useful Skills could not safely determine the profile workflow mode. Do not infer enabled workflow or fast-lane mode, authorize a native stage, or perform automatic memory actions from stale guidance. Inspect relevant current source and seek any independently required authorization; resolve the profile setting error before relying on workflow stages. Explicit user-directed actions and stronger safety rules remain independent.",
  ...STAGES.map(stage => `Useful Skills profile: automatic ${stage} stage enabled when the development workflow applies. Follow the relevant us-* skill's requirements for this stage; this setting is not evidence that the stage ran or permission to bypass other controls.`),
  ...STAGES.flatMap(stage => Object.values(STAGE_GUIDANCE[stage])),
]);
const GRAPH_TEST_QUERY = "main";
const HELP = [
  "Useful Skills for Oh My Pi",
  "/skill:us-<name> — load an owned skill; natural requests also select skills by description.",
  "/useful-skills list [query] — browse owned skills.",
  "/useful-skills workflow enabled|disabled — set the development workflow for this repository/checkout (default: enabled); outside Git, scoped to the canonical workspace.",
  "/useful-skills stage <research|plan|review|security-review|backend-memory|graphify-memory> enabled|disabled — set an independent automatic stage for this profile.",
  "/useful-skills status — read repository master and profile stage settings, paths, and errors.",
  "/skill:us-ignore-workflow — use the fast lane for one explicit request without changing saved settings.",
  "/useful-skills doctor — inspect resources and memory availability without setup.",
  "/useful-skills graph test — explicitly build this workspace graph and run a diagnostic query.",
  "/useful-skills update check|install — check or install marketplace updates.",
  "Memory: us_memory handles agent actions; native /memory is unchanged.",
  "Graphify setup is lazy on explicit build/query or graph test. No startup workflow dependency.",
  "Terminal: ./useful-skills list | doctor | update check|install",
].join("\n");

export default function usefulSkills(pi, { memoryAction = executeMemory } = {}) {
  pi.setLabel("Useful Skills");
  let busy = false;
  let startupScheduled = false;

  async function settings(ctx) {
    try {
      return await readWorkflowSettings({ agentDir: pi.pi.getAgentDir(), cwd: ctx.cwd });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const keys = ["workflow", ...STAGES];
      return {
        values: Object.fromEntries(keys.map(key => [key, undefined])),
        errors: Object.fromEntries(keys.map(key => [key, reason])),
      };
    }
  }

  function status(snapshot) {
    const policy = effectiveWorkflow(snapshot);
    const workflow = policy.workflow;

    return [
      "Useful Skills repository workflow and profile stage settings:",
      `Workflow scope root: ${snapshot.scopeRoot ?? "unknown"}`,
      `Repository workflow file: ${snapshot.workflowFile ?? "unknown"}`,
      `Profile stage directory: ${snapshot.directory ?? "unknown"}`,
      `Workflow: saved ${workflow.saved}, effective ${workflow.effective}${snapshot.errors.workflow ? ` (${snapshot.errors.workflow})` : ""}`,
      ...STAGES.map(stage => {
        const { saved, effective } = policy.stages[stage];
        const reason = snapshot.errors[stage] || (
          workflow.saved === "disabled" ? "workflow disabled" : workflow.saved === "unknown" ? "workflow setting unreadable" : ""
        );

        return `${STAGE_LABELS[stage]}: saved ${saved}, effective ${effective}${reason ? ` (${reason})` : ""}`;
      }),
    ].join("\n");
  }

  function notify(ctx, message, level = "info") {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    } else {
      pi.sendMessage(
        { customType: "useful-skills", content: message, display: true, attribution: "agent" },
        { triggerTurn: false },
      );
    }
  }

  function graphNotice(ctx, message, level = "info") {
    const text = redactText(message);
    const bytes = Buffer.from(text);
    const limit = 4_096;
    const suffix = "\n[display truncated]";
    notify(ctx, bytes.length <= limit ? text : `${bytes.subarray(0, limit - Buffer.byteLength(suffix)).toString("utf8")}${suffix}`, level);
  }

  async function graphTest(ctx) {
    graphNotice(ctx, "Building this workspace's Graphify graph, then running a diagnostic query. This explicit command may set up pinned dependencies and writes graph storage under your OMP profile outside the checkout.");
    const options = { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory };
    let build;
    try {
      build = await memoryAction({ action: "build" }, options);
      if (!build.ok) {
        return graphNotice(ctx, `Graphify build failed: ${build.error || "No build result was returned."}`, "error");
      }
      const { generation, graph } = build.active;
      const { nodes, edges, sources } = build.snapshot;
      graphNotice(ctx, `Graphify built generation ${generation}: ${nodes} nodes, ${edges} edges, ${sources} source files.\nGraph storage: ${graph}`);
    } catch (error) {
      return graphNotice(ctx, `Graphify build failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }

    try {
      const result = await memoryAction({ action: "query", query: GRAPH_TEST_QUERY }, options);
      if (!result.ok) {
        return graphNotice(ctx, `Graphify query failed: ${result.error || "No query result was returned."}`, "error");
      }
      if (result.active?.generation !== build.active.generation) {
        return graphNotice(ctx, `Graphify query failed: active generation changed from ${build.active.generation} to ${result.active?.generation ?? "unknown"}; results cannot be attributed to this build.`, "error");
      }
      if (typeof result.output !== "string") {
        return graphNotice(ctx, "Graphify query failed: no text output was returned.", "error");
      }
      const output = result.output.trim();
      graphNotice(ctx, output
        ? /^No matching nodes found\.?$/i.test(output)
          ? `Graphify query "${GRAPH_TEST_QUERY}" returned no matches${result.outputTruncated ? " (Graphify output truncated)" : ""}:\n${result.output}`
          : `Graphify query "${GRAPH_TEST_QUERY}" output${result.outputTruncated ? " (Graphify output truncated)" : ""}:\n${result.output}`
        : `Graphify query "${GRAPH_TEST_QUERY}" returned no output${result.outputTruncated ? " (Graphify output truncated)" : ""}; no relationships are claimed.`);
    } catch (error) {
      graphNotice(ctx, `Graphify query failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function update(action, ctx, quiet = false) {
    if (busy) {
      if (!quiet) {
        notify(ctx, "A Useful Skills update operation is already running.", "warning");
      }

      return;
    }

    busy = true;
    try {
      if (action === "install") {
        notify(ctx, "Updating Useful Skills through OMP's native plugin manager…");
      }

      const report = await runUpdate(action, { cwd: ctx.cwd, profile: process.env.OMP_PROFILE });
      if (report.updated) {
        notify(ctx, `Useful Skills updated to ${report.currentVersion}. Restart OMP to load the update.`);
      } else if (report.updateAvailable) {
        notify(ctx, `Useful Skills update available: ${report.currentVersion} → ${report.latestVersion}. Run /useful-skills update install.`, "warning");
      } else if (!quiet) {
        notify(ctx, `Useful Skills ${report.currentVersion}: ${report.message || "No newer stable release available."}`);
      }
    } catch (error) {
      if (!quiet) {
        notify(ctx, `Useful Skills update failed: ${error.message}`, "error");
      }
    } finally {
      busy = false;
    }
  }

  async function doctor(ctx) {
    const [core, memory] = await Promise.all([
      resourceInventory(),
      memoryAction({ action: "status" }, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory }),
    ]);
    notify(ctx, formatDoctor({ core, safety: safetyEnabled(), memory }));
  }

  async function workbench(args, ctx) {
    try {
      const refresh = settings(ctx);
      let command = args.trim();
      // Commands unrelated to workflow settings retain their synchronous progress notices.
      const directTokens = command.split(/\s+/);

      if (command === "doctor") {
        return await doctor(ctx);
      }

      if (directTokens[0] === "graph" && directTokens.length === 2 && directTokens[1] === "test") {
        return await graphTest(ctx);
      }

      if (directTokens[0] === "update" && directTokens.length === 2 && ["check", "install"].includes(directTokens[1])) {
        return await update(directTokens[1], ctx);
      }

      const snapshot = await refresh;
      if (!command && ctx.hasUI) {
        const saved = effectiveWorkflow(snapshot);
        const workflowChoice = `Repository Workflow ${ctx.ui.theme.fg("muted", `(${saved.workflow.saved})`)}`;
        const stageChoices = STAGES.map(stage => `${STAGE_LABELS[stage]} ${ctx.ui.theme.fg("muted", `(${saved.stages[stage].saved})`)}`);
        let menu = "root";
        let stage;

        const selectChild = async (title, choices) => {
          let left = false;
          const choice = await ctx.ui.select(title, choices, {
            onLeft: () => { left = true; },
            helpText: "← Back · Esc Close",
          });
          return { choice, left };
        };

        while (!command) {
          if (menu === "root") {
            const choice = await ctx.ui.select(
              "Useful Skills",
              ["List", "Doctor", "Status", workflowChoice, "Profile Workflow Stages", "Update", "Help"],
              { helpText: "Esc Close" },
            );
            if (!choice) {
              return;
            }

            if (choice === workflowChoice) {
              menu = "workflow";
            } else if (choice === "Profile Workflow Stages") {
              menu = "stages";
            } else if (choice === "Update") {
              menu = "update";
            } else {
              command = { List: "list", Doctor: "doctor", Status: "status", Help: "help" }[choice];
            }
          } else if (menu === "stages") {
            const { choice, left } = await selectChild("Profile Workflow Stages", stageChoices);
            if (left) {
              menu = "root";
              continue;
            }
            if (!choice) {
              return;
            }

            stage = STAGES[stageChoices.indexOf(choice)];
            if (!stage) {
              return;
            }
            menu = "stage-mode";
          } else {
            const title = menu === "workflow"
              ? `Repository workflow (${snapshot.scopeRoot ?? "unknown scope"}): ${saved.workflow.saved}`
              : menu === "stage-mode"
                ? `Profile ${STAGE_LABELS[stage]}: ${saved.stages[stage].saved}`
                : "Update";
            const choices = menu === "update" ? ["Check", "Install"] : ["Enabled", "Disabled"];
            const { choice, left } = await selectChild(title, choices);
            if (left) {
              menu = menu === "stage-mode" ? "stages" : "root";
              continue;
            }
            if (!choice) {
              return;
            }

            command = menu === "workflow"
              ? `workflow ${choice.toLowerCase()}`
              : menu === "stage-mode"
                ? `stage ${stage} ${choice.toLowerCase()}`
                : `update ${choice.toLowerCase()}`;
          }
        }
      }

      if (!command || command === "help") {
        return notify(ctx, HELP);
      }

      if (command === "status") {
        return notify(ctx, status(snapshot), Object.keys(snapshot.errors).length ? "warning" : "info");
      }

      if (command === "doctor") {
        return await doctor(ctx);
      }

      const tokens = command.split(/\s+/);
      if (tokens[0] === "workflow" || tokens[0] === "stage") {
        const stageCommand = tokens[0] === "stage";
        const key = stageCommand ? tokens[1] : "workflow";
        const mode = tokens[stageCommand ? 2 : 1];
        if (tokens.length !== (stageCommand ? 3 : 2) || (stageCommand && !STAGES.includes(key)) || !["enabled", "disabled"].includes(mode)) {
          const usage = stageCommand
            ? "stage <research|plan|review|security-review|backend-memory|graphify-memory> enabled|disabled"
            : "workflow enabled|disabled";
          return notify(ctx, `Expected /useful-skills ${usage}.\n${status(snapshot)}`, "warning");
        }

        // The store accepts replacement of a corrupt regular JSON value, but rejects unsafe paths.
        try {
          await writeWorkflowSetting({ agentDir: pi.pi.getAgentDir(), cwd: ctx.cwd, key, enabled: mode === "enabled" });
        } catch (error) {
          return notify(ctx, `Cannot change ${key}: ${error instanceof Error ? error.message : String(error)}`, "error");
        }

        const confirmed = await settings(ctx);
        const confirmedPolicy = effectiveWorkflow(confirmed);
        if (confirmed.errors[key] || (key === "workflow" ? confirmedPolicy.workflow.saved : confirmedPolicy.stages[key].saved) !== mode) {
          return notify(ctx, `Cannot confirm ${key} setting: ${confirmed.errors[key] || "scoped readback differs from the requested mode"}.\n${status(confirmed)}`, "error");
        }
        const scope = stageCommand ? "this OMP profile" : `this repository/workspace (${confirmed.scopeRoot})`;
        return notify(ctx, `Useful Skills ${key} ${mode} for ${scope}.`);
      }
      if (tokens[0] === "graph" && tokens.length === 2 && tokens[1] === "test") {
        return await graphTest(ctx);
      }
      if (tokens[0] === "update" && tokens.length === 2 && ["check", "install"].includes(tokens[1])) {
        return await update(tokens[1], ctx);
      }
      const { kind, query } = parseCatalogArguments(tokens);
      notify(ctx, formatResources(kind, await listResources(kind, { query }), query));
    } catch (error) {
      notify(ctx, `${error.message}\n${HELP}`, "warning");
    }
  }

  pi.registerCommand("useful-skills", {
    description: "Browse skills, health, graph diagnostics, and updates",
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
      const result = await memoryAction(args, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.ok === false ? { isError: true } : {}) };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const snapshot = await settings(ctx);
    const policy = effectiveWorkflow(snapshot);
    const mode = policy.workflow.effective;
    const desired = mode === "unknown"
      ? [UNKNOWN_SETTINGS_HINT]
      : mode === "disabled"
        ? [FAST_LANE_HINT]
        : [DISCOVERY_HINT, WORKFLOW_POLICY, ...STAGES.map(stage => STAGE_GUIDANCE[stage][policy.stages[stage].effective])];

    const retained = event.systemPrompt.filter(prompt => !OWNED_GUIDANCE.has(prompt));
    const next = [...retained, ...desired];
    return next.length === event.systemPrompt.length && next.every((prompt, index) => prompt === event.systemPrompt[index])
      ? undefined
      : { systemPrompt: next };
  });

  pi.on("tool_call", event => {
    if (!safetyEnabled() || event.toolName !== "bash") {
      return;
    }

    const reason = dangerousCommandReason(event.input?.command);
    if (reason) {
      return { block: true, reason: `Useful Skills safety guard: ${reason}. Use a reversible, explicitly approved operation instead.` };
    }
  });

  pi.on("tool_result", event => {
    const content = redactToolResultContent(event.content);
    return content ? { content } : undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || startupScheduled) {
      return;
    }

    startupScheduled = true;
    ctx.setTimeout(() => update("check", ctx, true), 0);
  });
}
